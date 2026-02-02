function safeEncode(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return encodeURIComponent(value);
  } catch (err) {

    return value;
  }
}

function safeDecode(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

export { safeEncode, safeDecode };