import { request, type RequestOptions } from './client.ts';

export const saveBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
};

export const downloadFile = async (
  scope: string,
  path: string,
  filename: string,
  options: Omit<RequestOptions, 'scope'> = {},
): Promise<void> => {
  const response = await request(path, { ...options, scope });
  saveBlob(await response.blob(), filename);
};
