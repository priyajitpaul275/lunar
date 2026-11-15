export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  description?: string;
  trashed?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
}

export interface DriveAboutInfo {
  user?: {
    displayName?: string;
    emailAddress?: string;
    photoLink?: string;
  };
  storageQuota?: {
    limit?: string;
    usage?: string;
    usageInDrive?: string;
  };
}

export class DriveAuthExpiredError extends Error {
  constructor(message = 'Google Drive access token expired or revoked. Please sign in again.') {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

async function handleDriveResponse(res: Response): Promise<Response> {
  if (res.status === 401) {
    throw new DriveAuthExpiredError();
  }
  if (!res.ok) {
    let detail = `Google Drive API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) {
        detail = errBody.error.message;
      }
    } catch {
      // Fallback to HTTP status
    }
    throw new Error(detail);
  }
  return res;
}

export async function fetchDriveAbout(token: string): Promise<DriveAboutInfo> {
  const url = `${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive)`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await handleDriveResponse(res);
  return (await res.json()) as DriveAboutInfo;
}

export async function listDriveFiles(
  token: string,
  options: { search?: string; clpsOnly?: boolean; pageSize?: number; pageToken?: string } = {}
): Promise<{ files: DriveFileItem[]; nextPageToken?: string }> {
  const { search = '', clpsOnly = false, pageSize = 25, pageToken } = options;

  const clauses: string[] = ['trashed = false'];
  if (clpsOnly) {
    clauses.push("(name contains 'clps' or name contains 'CLPS' or description contains 'CLPS')");
  }
  const trimmed = search.trim();
  if (trimmed) {
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    clauses.push(`name contains '${escaped}'`);
  }

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    pageSize: String(pageSize),
    orderBy: 'modifiedTime desc',
    fields:
      'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,description,trashed,owners(displayName,emailAddress))',
  });
  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await handleDriveResponse(res);
  return (await res.json()) as { files: DriveFileItem[]; nextPageToken?: string };
}

export async function findDriveFilesByExactName(
  token: string,
  exactName: string
): Promise<DriveFileItem[]> {
  const escaped = exactName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name = '${escaped}' and trashed = false`,
    pageSize: '10',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,description)',
  });
  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await handleDriveResponse(res);
  const data = (await res.json()) as { files?: DriveFileItem[] };
  return data.files || [];
}

export async function readDriveFileText(
  token: string,
  file: DriveFileItem
): Promise<{ text: string; exportedAs?: string }> {
  if (file.mimeType === 'application/vnd.google-apps.folder') {
    return { text: '[Google Drive Folder — open in Google Drive to view child items]' };
  }

  let url = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`;
  let exportedAs: string | undefined;

  if (file.mimeType === 'application/vnd.google-apps.document') {
    url = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`;
    exportedAs = 'text/plain';
  } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=text/csv`;
    exportedAs = 'text/csv';
  } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`;
    exportedAs = 'text/plain';
  } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    return {
      text: `[Workspace item (${file.mimeType}) cannot be previewed directly as plain text. Use Open in Drive.]`,
    };
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await handleDriveResponse(res);

  const isTextLike =
    exportedAs !== undefined ||
    file.mimeType.startsWith('text/') ||
    file.mimeType.includes('json') ||
    file.mimeType.includes('xml') ||
    file.mimeType.includes('csv') ||
    file.name.endsWith('.czml') ||
    file.name.endsWith('.json') ||
    file.name.endsWith('.lbl') ||
    file.name.endsWith('.md') ||
    file.name.endsWith('.txt');

  if (!isTextLike) {
    const blob = await res.blob();
    return {
      text: `[Binary file (${file.mimeType || 'application/octet-stream'}), ${blob.size.toLocaleString()} bytes]`,
    };
  }

  const raw = await res.text();
  if (raw.length > 120_000) {
    return {
      text: `${raw.slice(0, 120_000)}\n\n... [Truncated preview at 120,000 characters; total ${raw.length.toLocaleString()} chars]`,
      exportedAs,
    };
  }
  return { text: raw, exportedAs };
}

export async function uploadTextFileToDrive(
  token: string,
  options: {
    name: string;
    content: string;
    mimeType: string;
    description?: string;
    existingFileId?: string;
  }
): Promise<DriveFileItem> {
  const { name, content, mimeType, description, existingFileId } = options;
  const boundary = `clps_drive_boundary_${Date.now().toString(36)}`;

  const metadata: Record<string, unknown> = {
    name,
    mimeType,
  };
  if (description) {
    metadata.description = description;
  }

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const fields = 'id,name,mimeType,size,modifiedTime,webViewLink,description';
  const endpoint = existingFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=${fields}`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${fields}`;

  const res = await fetch(endpoint, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  await handleDriveResponse(res);
  return (await res.json()) as DriveFileItem;
}

export async function renameDriveFile(
  token: string,
  fileId: string,
  newName: string
): Promise<DriveFileItem> {
  const fields = 'id,name,mimeType,size,modifiedTime,webViewLink,description';
  const res = await fetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${fields}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: newName }),
    }
  );
  await handleDriveResponse(res);
  return (await res.json()) as DriveFileItem;
}

export async function trashDriveFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  });
  await handleDriveResponse(res);
}

export async function deleteDriveFilePermanently(
  token: string,
  fileId: string
): Promise<void> {
  const res = await fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  await handleDriveResponse(res);
}
