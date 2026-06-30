// Safely parse a value that is expected to be a JSON object.
//
// The stats endpoints legitimately return `{}` for an unknown device and, on
// error paths, can return a non-object body; localStorage can hold stale or
// corrupted values. Blindly casting `res.json()`/`JSON.parse()` to a concrete
// type asserts a shape the value may not have. These helpers confirm the value
// is a non-null, non-array object before handing it back as T (whose fields the
// caller must still treat as possibly-absent), and return null otherwise.

export const asObject = <T>(value: unknown): T | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;

// Parse a fetch Response body as a JSON object, or null if the body is not one.
export const parseJsonObject = async <T>(res: Response): Promise<T | null> => {
  try {
    return asObject<T>(await res.json());
  } catch {
    return null;
  }
};

// Parse a raw JSON string (e.g. a localStorage value) into an object, or null.
export const parseJsonString = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return asObject<T>(JSON.parse(raw));
  } catch {
    return null;
  }
};
