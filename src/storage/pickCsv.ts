import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

const CSV_TYPES = [
  'text/csv',
  'text/comma-separated-values',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
];

export function pickCsvText(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return pickCsvOnWeb();
  }
  return pickCsvOnNative();
}

function pickCsvOnWeb(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ['.csv', ...CSV_TYPES].join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (value: string | null, error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file.text().then((text) => finish(text)).catch((error: unknown) => finish(null, error));
    });
    input.addEventListener('cancel', () => {
      finish(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function pickCsvOnNative(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: CSV_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
    base64: false,
  });
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  if (asset.file) {
    return asset.file.text();
  }
  const response = await fetch(asset.uri);
  if (!response.ok) {
    throw new Error('Could not read that file.');
  }
  return response.text();
}
