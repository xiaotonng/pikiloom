# Deploying the pikiloom landing page

This is a **standalone static site** (Vite + React 19 + Tailwind 4 + React Bits).
It lives in `web/` inside the pikiloom repo, builds to `web/dist/`, and is **never
published to npm** (root `package.json` `files` only ships `dist/` + `dashboard/dist/`).

```bash
npm --prefix web install
npm --prefix web run build      # → web/dist/  (static, host anywhere)
npm --prefix web run dev        # local preview at http://localhost:4321
```

---

## Recommended: Cloudflare Pages (free, git auto-deploy, global CDN, free SSL)

Chosen because: zero cost, automatic deploy on every push, free wildcard SSL,
**no ICP filing required**, and the most reliable reachability from mainland China
among the international free hosts (better than Vercel / github.io).

### 1. Connect the repo (one-time)
Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** →
pick `xiaotonng/pikiloom`.

### 2. Build settings
| Field | Value |
|-------|-------|
| Production branch | `main` |
| Framework preset | `Vite` (or None) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| **Root directory (Advanced)** | `web` |

`web/.node-version` pins Node 22 (Vite 7 needs ≥20.19 / ≥22.12), so the CF build
matches local. First deploy gives you `https://<project>.pages.dev`.

### 3. Custom domain
Pages project → **Custom domains → Set up a domain** → enter your domain.

- **If the domain's DNS is already on Cloudflare** → one click; CF creates the record
  and provisions SSL automatically. Done.
- **If the domain is registered elsewhere** (阿里云 / Namecheap / GoDaddy …):
  - **Easiest:** move the domain's nameservers to Cloudflare (free plan) → then the
    custom-domain step above is one click.
  - **Or keep external DNS** and add records yourself:
    - `www`  → **CNAME** → `<project>.pages.dev`
    - apex `example.com` → CNAME flattening / ALIAS → `<project>.pages.dev`
      (if your registrar lacks ALIAS, host the apex on Cloudflare instead).

SSL is issued automatically; allow a few minutes for the cert to go active.

---

## Alternatives

- **Vercel** — best DX, same settings (Root dir `web`, build `npm run build`, output `dist`).
  Caveat: edge reachability from mainland China is less consistent than Cloudflare.
- **GitHub Pages** — repo is already on GitHub; works with a `CNAME` file + Actions
  build, but `github.io` can be slow/intermittent from China.
- **Domestic CDN** (阿里云 OSS+CDN / 腾讯 COS) — only if the audience is China-primary
  AND you complete ICP 备案 for the domain. Heavyweight; not recommended for an
  English-first open-source dev tool.

---

## ⚠️ Note for releases
`web/` is currently **untracked**. The release flow (`scripts/release.sh`) runs
`git add -A`, which would sweep `web/` into a release commit. Commit `web/` as its
own change first (`git add web/ && git commit`), or it'll ride along with the next
version bump unintentionally.
