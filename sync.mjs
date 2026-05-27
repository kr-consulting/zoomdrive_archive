import { google } from 'googleapis';
import axios from 'axios';
import qs from 'qs';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

// ============================
// CONFIG FROM ENV
// ============================
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const GSA_CREDENTIALS = JSON.parse(
  Buffer.from(process.env.GSA_CREDENTIALS, 'base64').toString('utf-8')
);
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '1');

// ============================
// DATE HELPERS
// ============================
function getDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  return {
    from: start.toISOString().split('T')[0],
    to: end.toISOString().split('T')[0],
  };
}

// ============================
// ZOOM AUTH
// ============================
async function getZoomToken() {
  const res = await axios.post(
    'https://zoom.us/oauth/token?grant_type=account_credentials',
    qs.stringify({ account_id: ZOOM_ACCOUNT_ID }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return res.data.access_token;
}

// ============================
// ZOOM — GET ALL USERS
// ============================
async function getAllUsers(token) {
  const res = await axios.get('https://api.zoom.us/v2/users?status=active&page_size=300', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data.users || [];
}

// ============================
// ZOOM — GET RECORDINGS PER USER
// ============================
async function getRecordings(token, userId, from, to) {
  try {
    const res = await axios.get(
      `https://api.zoom.us/v2/users/${userId}/recordings?page_size=100&from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.meetings || [];
  } catch (e) {
    console.log(`Failed to get recordings for user ${userId}: ${e.message}`);
    return [];
  }
}

// ============================
// GOOGLE DRIVE AUTH
// ============================
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: GSA_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ============================
// DRIVE — CREATE FOLDER
// ============================
async function createDriveFolder(drive, name, parentId) {
  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return res.data.id;
}

// ============================
// DRIVE — UPLOAD FILE
// ============================
async function uploadToDrive(drive, filePath, fileName, parentId, mimeType) {
  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: fs.createReadStream(filePath),
    },
    fields: 'id',
  });
  return res.data.id;
}

// ============================
// DOWNLOAD FILE LOCALLY
// ============================
async function downloadFile(url, token, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
  });

  await pipeline(res.data, fs.createWriteStream(destPath));
  console.log(`Downloaded: ${destPath}`);
}

// ============================
// PICK BEST MP4
// ============================
function pickMP4(files) {
  const preferred = ['shared_screen_with_speaker_view', 'speaker_view', 'gallery_view'];
  for (const type of preferred) {
    const f = files.find(x => x.file_type === 'MP4' && x.recording_type === type && x.status === 'completed');
    if (f) return f;
  }
  return files.find(x => x.file_type === 'MP4' && x.status === 'completed') || null;
}

// ============================
// PICK TRANSCRIPT
// ============================
function pickTranscript(files) {
  return files.find(f =>
    f.status === 'completed' && (
      f.file_type === 'TRANSCRIPT' ||
      f.file_type === 'VTT' ||
      f.recording_type === 'audio_transcript'
    )
  ) || null;
}

// ============================
// PROCESS ONE MEETING
// ============================
async function processMeeting(drive, meeting, token) {
  const date = new Date(meeting.start_time).toISOString().split('T')[0];
  const folderName = `${date} - ${meeting.topic.replace(/[^\w\s-]/g, '').substring(0, 50)}`;

  console.log(`Processing: ${folderName}`);

  // Create subfolder in Drive
  let folderId;
  try {
    folderId = await createDriveFolder(drive, folderName, GDRIVE_FOLDER_ID);
    console.log(`Created folder: ${folderName}`);
  } catch (e) {
    console.log(`Failed to create folder: ${e.message}`);
    return;
  }

  const files = meeting.recording_files || [];

  // Download and upload MP4
  const mp4 = pickMP4(files);
  if (mp4) {
    const mp4Name = `${folderName} - ${mp4.recording_type || 'video'}.mp4`;
    const mp4Path = `./downloads/${meeting.id}/${mp4Name}`;
    try {
      await downloadFile(mp4.download_url, token, mp4Path);
      await uploadToDrive(drive, mp4Path, mp4Name, folderId, 'video/mp4');
      console.log(`Uploaded MP4: ${mp4Name}`);
      fs.unlinkSync(mp4Path);
    } catch (e) {
      console.log(`MP4 failed for ${meeting.topic}: ${e.message}`);
    }
  } else {
    console.log(`No MP4 found for: ${meeting.topic}`);
  }

  // Download and upload transcript
  const transcript = pickTranscript(files);
  if (transcript) {
    const vttName = `${folderName}.vtt`;
    const vttPath = `./downloads/${meeting.id}/${vttName}`;
    try {
      await downloadFile(transcript.download_url, token, vttPath);
      await uploadToDrive(drive, vttPath, vttName, folderId, 'text/vtt');
      console.log(`Uploaded transcript: ${vttName}`);
      fs.unlinkSync(vttPath);
    } catch (e) {
      console.log(`Transcript failed for ${meeting.topic}: ${e.message}`);
    }
  } else {
    console.log(`No transcript found for: ${meeting.topic}`);
  }
}

// ============================
// MAIN
// ============================
async function main() {
  console.log('Starting Zoom → Drive sync...');

  const token = await getZoomToken();
  console.log('Zoom authenticated.');

  const drive = getDriveClient();
  console.log('Drive authenticated.');

  const { from, to } = getDateRange();
  console.log(`Date range: ${from} to ${to}`);

  const users = await getAllUsers(token);
  console.log(`Found ${users.length} users.`);

  let totalMeetings = 0;

  for (const user of users) {
    const meetings = await getRecordings(token, user.id, from, to);
    console.log(`User ${user.email}: ${meetings.length} meetings`);
    totalMeetings += meetings.length;

    for (const meeting of meetings) {
      await processMeeting(drive, meeting, token);
    }
  }

  console.log(`Done. Total meetings processed: ${totalMeetings}`);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});