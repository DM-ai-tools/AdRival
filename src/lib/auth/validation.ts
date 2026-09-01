export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(username: string): string | null {
  const value = normalizeUsername(username);
  if (value.length < 3) return "Username must be at least 3 characters";
  if (value.length > 32) return "Username must be 32 characters or fewer";
  if (!/^[a-z0-9_]+$/.test(value)) {
    return "Username may only use letters, numbers, and underscores";
  }
  return null;
}

export function validateDisplayName(name: string): string | null {
  const value = name.trim();
  if (value.length < 1) return "Name is required";
  if (value.length > 80) return "Name must be 80 characters or fewer";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be 128 characters or fewer";
  return null;
}

export function toPublicUser(user: {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}
