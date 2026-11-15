import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.activity',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.apps.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.install',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.photos.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.scripts',
] as const;

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);

// OAuth access token is intentionally cached strictly in memory (never localStorage/sessionStorage).
let cachedAccessToken: string | null = null;

function createGoogleDriveProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of DRIVE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return provider;
}

export function getCachedDriveToken(): string | null {
  return cachedAccessToken;
}

export function clearCachedDriveToken(): void {
  cachedAccessToken = null;
}

export function subscribeDriveAuth(
  onUserChange: (user: User | null, accessToken: string | null) => void
): () => void {
  return onAuthStateChanged(firebaseAuth, (user) => {
    if (!user) {
      cachedAccessToken = null;
      onUserChange(null, null);
    } else {
      onUserChange(user, cachedAccessToken);
    }
  });
}

export async function signInWithGoogleDrive(): Promise<{
  user: User;
  accessToken: string;
}> {
  const provider = createGoogleDriveProvider();
  const result = await signInWithPopup(firebaseAuth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken;
  if (!token) {
    throw new Error('Google OAuth did not return a Drive access token. Please grant Drive permissions and retry.');
  }
  cachedAccessToken = token;
  return { user: result.user, accessToken: token };
}

export async function signOutGoogleDrive(): Promise<void> {
  cachedAccessToken = null;
  await signOut(firebaseAuth);
}
