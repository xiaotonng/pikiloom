// Resolve a public/ asset against Vite's base path so links work whether the
// site is served from the domain root ('/') or a GitHub Pages project subpath
// ('/pikiclaw/'). BASE_URL always ends with a slash.
export const asset = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
