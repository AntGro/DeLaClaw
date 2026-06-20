// Single source of truth for backend logos.
// Import and call with desired size wherever a backend logo is needed.

const LOGOS = {
  googledrive: (size = 22) =>
    `<img src="https://www.gstatic.com/images/branding/productlogos/drive_2026/v1/web-48dp/logo_drive_2026_color_2x_web_48dp.png" alt="Google Drive" width="${size}" height="${size}" style="display:block;">`,

  supabase: (size = 18) =>
    `<svg width="${size}" height="${Math.round(size * 113 / 109)}" viewBox="0 0 109 113" fill="none" aria-label="Supabase"><path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627H99.1935C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="#249361"/><path d="M45.317 2.07103C48.1765-1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922-2.92775 62.8321 2.16513 56.4175L45.317 2.07103Z" fill="#3ECF8E"/></svg>`,

  local: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Local"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,

  demo: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-label="Demo"><rect x="1" y="1" width="7" height="7" rx="2" fill="#3b82f6"/><rect x="10" y="1" width="7" height="7" rx="2" fill="#6366f1"/><rect x="1" y="10" width="7" height="7" rx="2" fill="#22c55e"/><rect x="10" y="10" width="7" height="7" rx="2" fill="#ec4899"/></svg>`,
};

const LABELS = {
  googledrive: 'Google Drive',
  supabase: 'Supabase',
  local: 'Local',
  demo: 'Demo',
};

export { LOGOS, LABELS };
