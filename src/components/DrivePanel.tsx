import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  LogOut,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { CLPSMission } from '../data/clpsMissions';
import {
  IAU2015_MOON,
  computeLanderQuaternion,
  computeSolarZenithDeg,
  selenographicToMCMF,
} from '../engine/selenodesy';
import type { SampledEntityState } from '../workers/czmlWorker';
import {
  clearCachedDriveToken,
  getCachedDriveToken,
  signInWithGoogleDrive,
  signOutGoogleDrive,
  subscribeDriveAuth,
} from '../services/googleDriveAuth';
import {
  DriveAuthExpiredError,
  deleteDriveFilePermanently,
  fetchDriveAbout,
  findDriveFilesByExactName,
  listDriveFiles,
  readDriveFileText,
  renameDriveFile,
  trashDriveFile,
  uploadTextFileToDrive,
  type DriveAboutInfo,
  type DriveFileItem,
} from '../services/googleDriveApi';

interface QmStats {
  missionId: string;
  vertexCount: number;
  triangleCount: number;
  byteLength: number;
  minHeightM: number;
  maxHeightM: number;
  hasOctNormals: boolean;
  sampleOctPair: [number, number];
  sampleDecodedNormal: [number, number, number];
}

interface DrivePanelProps {
  selectedMission: CLPSMission;
  solarLonDeg: number;
  qmStats: QmStats | null;
  czmlStates: SampledEntityState[];
  rawCzmlPackets: unknown[];
}

type PendingConfirmation =
  | {
      kind: 'trash';
      file: DriveFileItem;
    }
  | {
      kind: 'delete';
      file: DriveFileItem;
    }
  | {
      kind: 'rename';
      file: DriveFileItem;
      nextName: string;
    }
  | {
      kind: 'overwrite';
      existingFile: DriveFileItem;
      fileName: string;
      content: string;
      mimeType: string;
      description: string;
    };

function formatBytes(rawSize?: string): string {
  if (!rawSize) return 'Workspace doc';
  const bytes = Number(rawSize);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMimeShort(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.folder') return 'Folder';
  if (mimeType === 'application/vnd.google-apps.document') return 'Google Doc';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'Google Slides';
  if (mimeType === 'application/json') return 'JSON';
  if (mimeType === 'text/plain') return 'Text';
  if (mimeType === 'text/csv') return 'CSV';
  if (mimeType === 'application/pdf') return 'PDF';
  const parts = mimeType.split('/');
  return parts[parts.length - 1] || mimeType;
}

function formatIsoDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function DrivePanel({
  selectedMission,
  solarLonDeg,
  qmStats,
  czmlStates,
  rawCzmlPackets,
}: DrivePanelProps) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => getCachedDriveToken());
  const [authLoading, setAuthLoading] = useState(false);

  const [about, setAbout] = useState<DriveAboutInfo | null>(null);
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [clpsOnly, setClpsOnly] = useState(false);

  const [exportingKind, setExportingKind] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [showNoteComposer, setShowNoteComposer] = useState(false);

  const [previewFile, setPreviewFile] = useState<DriveFileItem | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [pendingAction, setPendingAction] = useState<PendingConfirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [statusNotice, setStatusNotice] = useState<{
    type: 'info' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    const unsub = subscribeDriveAuth((nextUser, nextToken) => {
      setUser(nextUser);
      setAccessToken(nextToken);
      if (!nextToken) {
        setAbout(null);
        setFiles([]);
        setPreviewFile(null);
        setPreviewText(null);
      }
    });
    return unsub;
  }, []);

  const handleAuthError = useCallback((err: unknown) => {
    if (err instanceof DriveAuthExpiredError) {
      clearCachedDriveToken();
      setAccessToken(null);
      setStatusNotice({
        type: 'error',
        text: err.message,
      });
      return;
    }
    setStatusNotice({
      type: 'error',
      text: err instanceof Error ? err.message : 'Google Drive request failed.',
    });
  }, []);

  const loadDriveWorkspace = useCallback(
    async (token: string, searchQuery = activeSearch, filterClps = clpsOnly, pageToken?: string) => {
      setLoadingFiles(true);
      try {
        const [aboutRes, listRes] = await Promise.all([
          pageToken ? Promise.resolve(about) : fetchDriveAbout(token),
          listDriveFiles(token, {
            search: searchQuery,
            clpsOnly: filterClps,
            pageSize: 25,
            pageToken,
          }),
        ]);
        if (aboutRes) setAbout(aboutRes);
        setFiles((prev) => (pageToken ? [...prev, ...(listRes.files || [])] : listRes.files || []));
        setNextPageToken(listRes.nextPageToken);
      } catch (err) {
        handleAuthError(err);
      } finally {
        setLoadingFiles(false);
      }
    },
    [about, activeSearch, clpsOnly, handleAuthError]
  );

  useEffect(() => {
    if (accessToken) {
      loadDriveWorkspace(accessToken, activeSearch, clpsOnly);
    }
  }, [accessToken, activeSearch, clpsOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignIn = async () => {
    setAuthLoading(true);
    setStatusNotice(null);
    try {
      const { user: signedInUser, accessToken: token } = await signInWithGoogleDrive();
      setUser(signedInUser);
      setAccessToken(token);
      setStatusNotice({
        type: 'info',
        text: `Connected to Google Drive as ${signedInUser.email || signedInUser.displayName || 'Google account'}.`,
      });
    } catch (err) {
      setStatusNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Google sign-in failed.',
      });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    setStatusNotice(null);
    try {
      await signOutGoogleDrive();
      setUser(null);
      setAccessToken(null);
      setAbout(null);
      setFiles([]);
      setPreviewFile(null);
      setPreviewText(null);
    } catch (err) {
      setStatusNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Sign out failed.',
      });
    }
  };

  const initiateUploadWithDuplicateCheck = async (options: {
    fileName: string;
    content: string;
    mimeType: string;
    description: string;
  }) => {
    if (!accessToken) return;
    const matches = await findDriveFilesByExactName(accessToken, options.fileName);
    if (matches.length > 0) {
      setPendingAction({
        kind: 'overwrite',
        existingFile: matches[0],
        fileName: options.fileName,
        content: options.content,
        mimeType: options.mimeType,
        description: options.description,
      });
      return;
    }

    const created = await uploadTextFileToDrive(accessToken, {
      name: options.fileName,
      content: options.content,
      mimeType: options.mimeType,
      description: options.description,
    });
    setStatusNotice({
      type: 'info',
      text: `Saved "${created.name}" to Google Drive.`,
    });
    await loadDriveWorkspace(accessToken);
  };

  const handleExportEphemeris = async () => {
    if (!accessToken) return;
    setExportingKind('ephemeris');
    setStatusNotice(null);
    try {
      const res = await fetch(
        `/api/ephemeris/libration?missionId=${encodeURIComponent(selectedMission.id)}`
      );
      if (!res.ok) throw new Error(`Ephemeris endpoint returned HTTP ${res.status}`);
      const payload = await res.json();
      await initiateUploadWithDuplicateCheck({
        fileName: `clps-ephemeris-${selectedMission.id}.json`,
        content: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
        description: `CLPS rfc-2026-clps-v1.0 libration & DTE ephemeris for ${selectedMission.name} (${selectedMission.taskOrder})`,
      });
    } catch (err) {
      handleAuthError(err);
    } finally {
      setExportingKind(null);
    }
  };

  const handleExportCzml = async () => {
    if (!accessToken) return;
    setExportingKind('czml');
    setStatusNotice(null);
    try {
      let packets = rawCzmlPackets;
      if (!packets || packets.length === 0) {
        const res = await fetch('/api/czml/missions');
        if (!res.ok) throw new Error(`CZML endpoint returned HTTP ${res.status}`);
        packets = await res.json();
      }
      await initiateUploadWithDuplicateCheck({
        fileName: `clps-telemetry-${selectedMission.id}.czml`,
        content: JSON.stringify(packets, null, 2),
        mimeType: 'application/json',
        description: `CLPS CZML 1.0 trajectory stream snapshot for ${selectedMission.name} (${selectedMission.taskOrder})`,
      });
    } catch (err) {
      handleAuthError(err);
    } finally {
      setExportingKind(null);
    }
  };

  const handleExportMissionReport = async () => {
    if (!accessToken) return;
    setExportingKind('report');
    setStatusNotice(null);
    try {
      const mcmf = selenographicToMCMF(
        selectedMission.lonDeg,
        selectedMission.latDeg,
        selectedMission.elevationM
      );
      const q = computeLanderQuaternion(
        selectedMission.lonDeg,
        selectedMission.latDeg,
        selectedMission.attitudeEulerDeg
      );
      const solarZenithDeg = computeSolarZenithDeg(
        selectedMission.lonDeg,
        selectedMission.latDeg,
        solarLonDeg
      );
      const missionStates = czmlStates.filter(
        (st) =>
          st.id === selectedMission.id ||
          (selectedMission.id === 'to20a' && st.id === 'flip-rover') ||
          (Boolean(selectedMission.hasRelayLink) && st.id === 'lunar-pathfinder-relay')
      );
      const report = {
        schema: 'clps-mission-snapshot-v1',
        exportedAt: new Date().toISOString(),
        referenceFrame: 'IAU2015_Moon / MOON_ME',
        meanRadiusM: IAU2015_MOON.MEAN_RADIUS_M,
        mission: {
          id: selectedMission.id,
          taskOrder: selectedMission.taskOrder,
          name: selectedMission.name,
          contractor: selectedMission.contractor,
          landerClass: selectedMission.landerClass,
          destination: selectedMission.destination,
          hemisphere: selectedMission.hemisphere,
          statusLabel: selectedMission.statusLabel,
          latDeg: selectedMission.latDeg,
          lonDeg: selectedMission.lonDeg,
          elevationM: selectedMission.elevationM,
          payloads: selectedMission.payloads,
        },
        selenodeticState: {
          mcmfCartesianM: mcmf,
          attitudeQuaternion: q,
          solarLongitudeDeg: solarLonDeg,
          solarZenithDeg: Number(solarZenithDeg.toFixed(3)),
        },
        quantizedMeshPatch: qmStats?.missionId === selectedMission.id ? qmStats : null,
        sampledCzmlStates: missionStates,
      };
      await initiateUploadWithDuplicateCheck({
        fileName: `clps-mission-report-${selectedMission.id}.json`,
        content: JSON.stringify(report, null, 2),
        mimeType: 'application/json',
        description: `CLPS Lunar Browser mission engineering snapshot for ${selectedMission.name}`,
      });
    } catch (err) {
      handleAuthError(err);
    } finally {
      setExportingKind(null);
    }
  };

  const handleSaveNote = async () => {
    if (!accessToken) return;
    const rawName = noteTitle.trim() || `clps-note-${selectedMission.id}.md`;
    const safeName = rawName.includes('.') ? rawName : `${rawName}.md`;
    if (!noteBody.trim()) {
      setStatusNotice({ type: 'error', text: 'Enter note content before saving to Google Drive.' });
      return;
    }
    setExportingKind('note');
    setStatusNotice(null);
    try {
      await initiateUploadWithDuplicateCheck({
        fileName: safeName,
        content: noteBody,
        mimeType: 'text/plain',
        description: `CLPS engineering note for ${selectedMission.name} (${selectedMission.taskOrder})`,
      });
      setNoteTitle('');
      setNoteBody('');
      setShowNoteComposer(false);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setExportingKind(null);
    }
  };

  const handleInspectFile = async (file: DriveFileItem) => {
    if (!accessToken) return;
    setPreviewFile(file);
    setPreviewText(null);
    setPreviewLoading(true);
    try {
      const { text } = await readDriveFileText(accessToken, file);
      setPreviewText(text);
    } catch (err) {
      handleAuthError(err);
      setPreviewText(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirmPendingAction = async (mode?: 'overwrite' | 'copy') => {
    if (!accessToken || !pendingAction) return;
    setConfirmBusy(true);
    setStatusNotice(null);
    try {
      if (pendingAction.kind === 'trash') {
        await trashDriveFile(accessToken, pendingAction.file.id);
        if (previewFile?.id === pendingAction.file.id) {
          setPreviewFile(null);
          setPreviewText(null);
        }
        setStatusNotice({
          type: 'info',
          text: `Moved "${pendingAction.file.name}" to Google Drive Trash.`,
        });
      } else if (pendingAction.kind === 'delete') {
        await deleteDriveFilePermanently(accessToken, pendingAction.file.id);
        if (previewFile?.id === pendingAction.file.id) {
          setPreviewFile(null);
          setPreviewText(null);
        }
        setStatusNotice({
          type: 'info',
          text: `Permanently deleted "${pendingAction.file.name}" from Google Drive.`,
        });
      } else if (pendingAction.kind === 'rename') {
        const trimmed = pendingAction.nextName.trim();
        if (!trimmed) {
          setConfirmBusy(false);
          return;
        }
        const updated = await renameDriveFile(accessToken, pendingAction.file.id, trimmed);
        if (previewFile?.id === updated.id) {
          setPreviewFile(updated);
        }
        setStatusNotice({
          type: 'info',
          text: `Renamed file to "${updated.name}".`,
        });
      } else if (pendingAction.kind === 'overwrite') {
        if (mode === 'copy') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const dotIdx = pendingAction.fileName.lastIndexOf('.');
          const copyName =
            dotIdx > 0
              ? `${pendingAction.fileName.slice(0, dotIdx)}-${stamp}${pendingAction.fileName.slice(dotIdx)}`
              : `${pendingAction.fileName}-${stamp}`;
          const created = await uploadTextFileToDrive(accessToken, {
            name: copyName,
            content: pendingAction.content,
            mimeType: pendingAction.mimeType,
            description: pendingAction.description,
          });
          setStatusNotice({
            type: 'info',
            text: `Saved timestamped copy "${created.name}" to Google Drive.`,
          });
        } else {
          const updated = await uploadTextFileToDrive(accessToken, {
            name: pendingAction.fileName,
            content: pendingAction.content,
            mimeType: pendingAction.mimeType,
            description: pendingAction.description,
            existingFileId: pendingAction.existingFile.id,
          });
          setStatusNotice({
            type: 'info',
            text: `Updated existing Drive file "${updated.name}".`,
          });
        }
      }
      setPendingAction(null);
      await loadDriveWorkspace(accessToken);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setConfirmBusy(false);
    }
  };

  if (!accessToken) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Google Drive Mission Workspace</h3>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            Authenticate with your Google account to archive CLPS CZML telemetry streams,{' '}
            <span className="font-mono text-slate-300">rfc-2026-clps-v1.0</span> libration reports,
            and engineering notes directly to Google Drive, or inspect existing Drive datasets.
          </p>
        </div>

        <div className="p-3.5 bg-[#070A10] border border-slate-800 rounded space-y-3">
          {user && (
            <div className="text-xs text-amber-300">
              Session detected for {user.email || user.displayName}. Re-authorize Google Drive to
              obtain a fresh in-memory OAuth access token.
            </div>
          )}

          <button
            type="button"
            onClick={handleSignIn}
            disabled={authLoading}
            className="inline-flex items-center justify-center gap-3 h-10 px-4 rounded bg-white text-[#1f1f1f] border border-[#747775] hover:bg-[#f8f9fa] active:bg-[#eeeeee] text-[14px] font-medium tracking-[0.25px] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 48 48"
              className="w-[18px] h-[18px] shrink-0"
              aria-hidden="true"
            >
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            <span>{authLoading ? 'Authorizing...' : 'Sign in with Google'}</span>
          </button>

          <div className="text-[11px] text-slate-400 leading-relaxed">
            Access tokens stay strictly in memory for this session and are never persisted to browser
            storage. Destructive or overwriting Drive actions always ask for explicit confirmation.
          </div>
        </div>

        {statusNotice && (
          <div
            className={`p-3 rounded border text-xs ${
              statusNotice.type === 'error'
                ? 'border-rose-900/60 bg-rose-950/30 text-rose-300'
                : 'border-cyan-900/60 bg-cyan-950/30 text-cyan-200'
            }`}
          >
            {statusNotice.text}
          </div>
        )}
      </div>
    );
  }

  const quotaUsed = formatBytes(about?.storageQuota?.usageInDrive || about?.storageQuota?.usage);
  const quotaLimit = about?.storageQuota?.limit ? formatBytes(about.storageQuota.limit) : 'Unlimited';

  return (
    <div className="space-y-4">
      {/* Account & Storage Summary */}
      <div className="p-3 bg-[#070A10] border border-slate-800 rounded space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100 truncate">
              {about?.user?.displayName || user?.displayName || 'Google Drive Account'}
            </div>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              {about?.user?.emailAddress || user?.email || 'Authenticated'}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => loadDriveWorkspace(accessToken)}
              disabled={loadingFiles}
              className="p-1.5 text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded cursor-pointer disabled:opacity-50"
              title="Refresh Drive files"
              aria-label="Refresh Drive files"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingFiles ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded inline-flex items-center gap-1 cursor-pointer"
            >
              <LogOut className="w-3 h-3" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
        <div className="text-[11px] font-mono text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
          <span>Drive Usage</span>
          <span className="text-cyan-300">
            {quotaUsed} / {quotaLimit}
          </span>
        </div>
      </div>

      {statusNotice && (
        <div
          className={`p-2.5 rounded border text-xs flex items-start justify-between gap-2 ${
            statusNotice.type === 'error'
              ? 'border-rose-900/60 bg-rose-950/30 text-rose-300'
              : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
          }`}
        >
          <span>{statusNotice.text}</span>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-slate-400 hover:text-white cursor-pointer shrink-0"
            aria-label="Dismiss notice"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Active Mission Export Actions */}
      <div className="p-3 bg-[#070A10] border border-slate-800 rounded space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-xs font-semibold text-slate-100">
              Archive Active Mission to Drive
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {selectedMission.taskOrder} · {selectedMission.name}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNoteComposer((s) => !s)}
            className="px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded cursor-pointer shrink-0"
          >
            {showNoteComposer ? 'Close Note' : '+ Field Note'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            type="button"
            onClick={handleExportEphemeris}
            disabled={exportingKind !== null}
            className="px-2.5 py-1.5 text-[11px] font-medium bg-amber-500 text-slate-950 rounded hover:bg-amber-400 inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <UploadCloud className="w-3.5 h-3.5 shrink-0" />
            <span>{exportingKind === 'ephemeris' ? 'Saving...' : 'Ephemeris JSON'}</span>
          </button>
          <button
            type="button"
            onClick={handleExportCzml}
            disabled={exportingKind !== null}
            className="px-2.5 py-1.5 text-[11px] font-medium bg-slate-800 text-slate-100 rounded hover:bg-slate-700 inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <UploadCloud className="w-3.5 h-3.5 shrink-0" />
            <span>{exportingKind === 'czml' ? 'Saving...' : 'CZML Stream'}</span>
          </button>
          <button
            type="button"
            onClick={handleExportMissionReport}
            disabled={exportingKind !== null}
            className="px-2.5 py-1.5 text-[11px] font-medium bg-slate-800 text-slate-100 rounded hover:bg-slate-700 inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <UploadCloud className="w-3.5 h-3.5 shrink-0" />
            <span>{exportingKind === 'report' ? 'Saving...' : 'Site Snapshot'}</span>
          </button>
        </div>

        {showNoteComposer && (
          <div className="pt-2.5 border-t border-slate-800 space-y-2">
            <input
              type="text"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
              placeholder={`clps-note-${selectedMission.id}.md`}
              className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0B0F18] border border-slate-800 rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/70"
            />
            <textarea
              rows={4}
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder={`Engineering observation for ${selectedMission.name} (${selectedMission.destination})...`}
              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F18] border border-slate-800 rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/70"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveNote}
                disabled={exportingKind !== null}
                className="px-3 py-1.5 text-xs font-medium bg-cyan-500 text-slate-950 rounded hover:bg-cyan-400 cursor-pointer disabled:opacity-50"
              >
                {exportingKind === 'note' ? 'Uploading...' : 'Save Note to Drive'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Drive File Search & Filter */}
      <div className="space-y-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setActiveSearch(searchInput);
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search Google Drive files by name..."
              className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-[#070A10] border border-slate-800 rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/70"
            />
          </div>
          <button
            type="submit"
            className="px-2.5 py-1.5 text-xs font-medium bg-slate-800 text-slate-200 rounded hover:bg-slate-700 cursor-pointer shrink-0"
          >
            Search
          </button>
        </form>

        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setClpsOnly(false)}
              className={`px-2 py-1 rounded cursor-pointer ${
                !clpsOnly ? 'bg-slate-800 text-slate-100 font-medium' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All Files
            </button>
            <button
              type="button"
              onClick={() => setClpsOnly(true)}
              className={`px-2 py-1 rounded cursor-pointer ${
                clpsOnly ? 'bg-slate-800 text-slate-100 font-medium' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              CLPS Exports
            </button>
          </div>
          <span className="font-mono text-slate-400">{files.length} shown</span>
        </div>
      </div>

      {/* File Preview Pane */}
      {previewFile && (
        <div className="border border-cyan-800/70 bg-[#070A10] rounded overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between gap-2 bg-[#0B0F18]">
            <div className="min-w-0 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="text-xs font-mono text-slate-100 truncate">{previewFile.name}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPreviewFile(null);
                setPreviewText(null);
              }}
              className="p-1 text-slate-400 hover:text-white cursor-pointer shrink-0"
              aria-label="Close file preview"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-3 max-h-56 overflow-auto text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-words">
            {previewLoading ? 'Loading file content from Google Drive...' : previewText || 'No content.'}
          </div>
        </div>
      )}

      {/* Files List */}
      <div className="border border-slate-800 rounded bg-[#070A10] divide-y divide-slate-800/80">
        {loadingFiles && files.length === 0 && (
          <div className="p-4 text-xs text-slate-400">Loading Google Drive files...</div>
        )}

        {!loadingFiles && files.length === 0 && (
          <div className="p-4 text-xs text-slate-400">
            No matching files found in Google Drive. Use the archive buttons above to upload
            mission ephemeris, CZML, or reports.
          </div>
        )}

        {files.map((file) => {
          const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
          return (
            <div key={file.id} className="p-2.5 space-y-1.5 hover:bg-slate-900/40 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-center gap-1.5">
                  {isFolder ? (
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  )}
                  <span className="text-xs font-medium text-slate-100 truncate" title={file.name}>
                    {file.name}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-cyan-400 shrink-0">
                  {formatMimeShort(file.mimeType)}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                <span>
                  {formatBytes(file.size)} · {formatIsoDate(file.modifiedTime)}
                </span>
              </div>

              <div className="flex items-center gap-2 pt-0.5 text-[11px]">
                {!isFolder && (
                  <button
                    type="button"
                    onClick={() => handleInspectFile(file)}
                    className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Eye className="w-3 h-3" />
                    <span>Inspect</span>
                  </button>
                )}
                {file.webViewLink && (
                  <a
                    href={file.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1"
                  >
                    <span>Open</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setPendingAction({
                      kind: 'rename',
                      file,
                      nextName: file.name,
                    })
                  }
                  className="text-slate-300 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                >
                  <Pencil className="w-3 h-3" />
                  <span>Rename</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction({ kind: 'trash', file })}
                  className="text-rose-400 hover:text-rose-300 inline-flex items-center gap-1 cursor-pointer ml-auto"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Trash</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction({ kind: 'delete', file })}
                  className="text-rose-500 hover:text-rose-400 cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {nextPageToken && (
        <button
          type="button"
          onClick={() => loadDriveWorkspace(accessToken, activeSearch, clpsOnly, nextPageToken)}
          disabled={loadingFiles}
          className="w-full py-1.5 text-xs font-medium bg-slate-900 border border-slate-800 rounded text-slate-300 hover:text-white cursor-pointer disabled:opacity-50"
        >
          {loadingFiles ? 'Loading...' : 'Load More Files'}
        </button>
      )}

      {/* Mandatory Explicit Confirmation Modal for Destructive / Mutating Drive Operations */}
      {pendingAction && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-confirm-title"
        >
          <div className="w-full max-w-md bg-[#0B0F18] border border-slate-700 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h4 id="drive-confirm-title" className="text-sm font-semibold text-slate-100">
                  {pendingAction.kind === 'trash' && 'Confirm Move to Google Drive Trash'}
                  {pendingAction.kind === 'delete' && 'Confirm Permanent Google Drive Deletion'}
                  {pendingAction.kind === 'rename' && 'Confirm Google Drive File Rename'}
                  {pendingAction.kind === 'overwrite' && 'Existing Drive File Detected'}
                </h4>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  {pendingAction.kind === 'trash' &&
                    `Are you sure you want to move "${pendingAction.file.name}" to your Google Drive Trash?`}
                  {pendingAction.kind === 'delete' &&
                    `This will permanently delete "${pendingAction.file.name}" from Google Drive and bypass Trash. This cannot be undone.`}
                  {pendingAction.kind === 'rename' &&
                    `Update the filename in Google Drive for "${pendingAction.file.name}":`}
                  {pendingAction.kind === 'overwrite' &&
                    `A file named "${pendingAction.fileName}" already exists in your Google Drive (modified ${formatIsoDate(
                      pendingAction.existingFile.modifiedTime
                    )}). Choose whether to overwrite it or save a timestamped copy.`}
                </p>
              </div>
            </div>

            {pendingAction.kind === 'rename' && (
              <input
                type="text"
                value={pendingAction.nextName}
                onChange={(e) =>
                  setPendingAction({ ...pendingAction, nextName: e.target.value })
                }
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#070A10] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-amber-500"
              />
            )}

            <div className="bg-[#070A10] border border-slate-800 rounded p-2 text-[11px] font-mono text-slate-400 truncate">
              File ID:{' '}
              {pendingAction.kind === 'overwrite'
                ? pendingAction.existingFile.id
                : pendingAction.file.id}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                disabled={confirmBusy}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-slate-200 rounded hover:bg-slate-700 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>

              {pendingAction.kind === 'overwrite' ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleConfirmPendingAction('copy')}
                    disabled={confirmBusy}
                    className="px-3 py-1.5 text-xs font-medium bg-cyan-500 text-slate-950 rounded hover:bg-cyan-400 cursor-pointer disabled:opacity-50"
                  >
                    {confirmBusy ? 'Saving...' : 'Save Timestamped Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirmPendingAction('overwrite')}
                    disabled={confirmBusy}
                    className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-slate-950 rounded hover:bg-amber-400 cursor-pointer disabled:opacity-50"
                  >
                    {confirmBusy ? 'Updating...' : 'Overwrite Existing'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleConfirmPendingAction()}
                  disabled={
                    confirmBusy ||
                    (pendingAction.kind === 'rename' && !pendingAction.nextName.trim())
                  }
                  className={`px-3 py-1.5 text-xs font-medium rounded cursor-pointer disabled:opacity-50 ${
                    pendingAction.kind === 'delete' || pendingAction.kind === 'trash'
                      ? 'bg-rose-600 text-white hover:bg-rose-500'
                      : 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                  }`}
                >
                  {confirmBusy
                    ? 'Processing...'
                    : pendingAction.kind === 'trash'
                    ? 'Move to Trash'
                    : pendingAction.kind === 'delete'
                    ? 'Delete Permanently'
                    : 'Confirm Rename'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
