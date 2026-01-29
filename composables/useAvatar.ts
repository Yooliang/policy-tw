export function getAvatarUrl(avatarUrl: string | null | undefined, name: string): string {
  if (avatarUrl) return avatarUrl
  return `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(name)}`
}
