export const PRODUCTION_PUBLIC_HOSTNAME = 'app.xiaxue.site';
export const PRODUCTION_ADMIN_HOSTNAME = 'admin.xiaxue.site';
export const ADMIN_INTERNAL_PREFIX = '/__admin';

const ADMIN_ASSET_REWRITES = Object.freeze(new Map([
  ['/', '/__admin/index.html'],
  ['/index.html', '/__admin/index.html'],
  ['/production-console.css', '/__admin/production-console.css'],
  ['/production-console.js', '/__admin/production-console.js'],
  ['/admin-release.json', '/__admin/admin-release.json'],
]));

const ADMIN_PUBLIC_ASSET_NAMES = Object.freeze(new Set([
  '/production-console.css',
  '/production-console.js',
  '/admin-release.json',
]));

function normalizedPath(url) {
  const raw = url.pathname || '/';
  if (/\\|%2f|%5c|%00/iu.test(raw)) return null;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\') || decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isPathPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function productionHostDecision(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input || ''));
  } catch {
    return Object.freeze({ action: 'deny', status: 400, code: 'INVALID_REQUEST_URL' });
  }

  const hostname = String(url.hostname || '').toLowerCase();
  const pathname = normalizedPath(url);
  if (!pathname) return Object.freeze({ action: 'deny', status: 400, code: 'NON_CANONICAL_PATH' });

  if (hostname === PRODUCTION_PUBLIC_HOSTNAME) {
    if (isPathPrefix(pathname.toLowerCase(), ADMIN_INTERNAL_PREFIX)
        || isPathPrefix(pathname.toLowerCase(), '/api/admin')
        || ADMIN_PUBLIC_ASSET_NAMES.has(pathname.toLowerCase())) {
      return Object.freeze({ action: 'deny', status: 404, code: 'PUBLIC_HOST_ADMIN_ROUTE_DENIED' });
    }
    return Object.freeze({ action: 'next', surface: 'public' });
  }

  if (hostname === PRODUCTION_ADMIN_HOSTNAME) {
    const lower = pathname.toLowerCase();
    if (isPathPrefix(lower, ADMIN_INTERNAL_PREFIX)) {
      return Object.freeze({ action: 'deny', status: 404, code: 'ADMIN_INTERNAL_PATH_DENIED' });
    }
    if (isPathPrefix(lower, '/api/admin')) {
      return Object.freeze({ action: 'next', surface: 'administrator' });
    }
    const destination = ADMIN_ASSET_REWRITES.get(lower);
    if (destination) {
      return Object.freeze({ action: 'rewrite', surface: 'administrator', destination });
    }
    return Object.freeze({ action: 'deny', status: 404, code: 'ADMIN_HOST_ROUTE_DENIED' });
  }

  return Object.freeze({ action: 'deny', status: 421, code: 'PRODUCTION_HOST_NOT_ALLOWED' });
}

function deniedResponse(decision) {
  const body = JSON.stringify({
    ok: false,
    error: {
      code: decision.code,
      message: '请求入口不可用',
    },
  });
  return new Response(body, {
    status: decision.status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

export function middleware(context) {
  const decision = productionHostDecision(context?.request?.url);
  if (decision.action === 'next') return context.next();
  if (decision.action === 'rewrite') return context.rewrite(decision.destination);
  return deniedResponse(decision);
}

export const config = Object.freeze({
  matcher: ['/:path*'],
});
