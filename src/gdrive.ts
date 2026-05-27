import * as core from '@actions/core'
import type {drive_v3} from 'googleapis'
import fs from 'fs'
import {prettyFileSize, progressBar} from './utils'
import {ZoomFile} from './zoom'

const log = (msg: string): void => {
  core.debug(`[gdrive-api] ${msg}`)
}

const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID || ''

export async function createFolder(
  drive: drive_v3.Drive,
  name: string,
  parent: string,
  driveId?: string
): Promise<string | null | undefined> {
  const requestBody: any = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parent],
  }

  const params: any = {
    supportsAllDrives: true,
    requestBody,
    fields: 'id',
  }

  const res = await drive.files.create(params)
  return res.data.id
}

export async function syncToGoogleDrive(
  drive: drive_v3.Drive,
  files: ZoomFile[],
  total_size: number,
  meetingFolderMap: {[key: string]: string | false},
  onSuccess: (file: ZoomFile) => void
): Promise<drive_v3.Schema$File[]> {
  files = files.filter(file => meetingFolderMap[file.id] !== false)
  const responses = []
  const subFoldersLookup: {[key: string]: string} = {}
  let uploadedSize = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const folderId = meetingFolderMap[file.id] ?? meetingFolderMap['default']

    if (folderId === false) {
      continue
    }

    if (folderId === undefined) {
      throw new Error(
        `No folder ID found for meeting ${file.id} (${file.topic}) nor a default folder ID provided.`
      )
    }

    const lookupId = `${file.id}.${file.date}`
    if (!subFoldersLookup[lookupId]) {
      log(
        `${progressBar(uploadedSize / total_size)} of ${prettyFileSize(
          total_size
        )} - Creating subfolder for meeting "${file.topic}" (${file.id})`
      )

      const folderName = meetingFolderMap[file.id]
        ? file.date
        : `${file.date} - ${file.topic} (${file.id})`

      const driveFolderId = await createFolder(drive, folderName, folderId)

      if (driveFolderId) {
        subFoldersLookup[lookupId] = driveFolderId
      } else {
        throw new Error(
          `Failed to create folder for meeting "${file.topic}" (${file.id})`
        )
      }
    }

    const {name} = file
    const media = {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(file.path),
    }
    const subFolder = subFoldersLookup[lookupId]

    log(
      `${progressBar(uploadedSize / total_size)} of ${prettyFileSize(
        total_size
      )} - Uploading ${i + 1}/${files.length} "${file.path}" ${prettyFileSize(
        file.recording.file_size
      )}`
    )

    const res = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name,
        parents: [subFolder],
      },
      media,
      fields: 'id',
    })

    uploadedSize += file.recording.file_size
    responses.push(res as drive_v3.Schema$File)
    onSuccess(file)
  }

  if (uploadedSize) {
    log(
      `${progressBar(1)} - Upload complete. Total size: ${prettyFileSize(uploadedSize)}`
    )
  }

  return responses
}
