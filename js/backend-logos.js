// Single source of truth for backend logos.
// Import and call with desired size wherever a backend logo is needed.

const LOGOS = {
  googledrive: (size = 22) =>
    `<img src="icons/brand/googledrive.svg" alt="Google Drive" width="${size}" height="${size}" style="display:block;">`,


  local: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-label="Local"><rect x="3" y="3" width="18" height="6" rx="2" fill="#7c3aed"/><circle cx="7" cy="6" r="1" fill="#c4b5fd"/><circle cx="10" cy="6" r="1" fill="#c4b5fd"/><rect x="15" y="5" width="3" height="2" rx="0.5" fill="#c4b5fd" opacity="0.6"/><rect x="3" y="11" width="18" height="6" rx="2" fill="#6d28d9"/><circle cx="7" cy="14" r="1" fill="#c4b5fd"/><circle cx="10" cy="14" r="1" fill="#c4b5fd"/><rect x="15" y="13" width="3" height="2" rx="0.5" fill="#c4b5fd" opacity="0.6"/><path d="M12 19v2M8 21h8" stroke="#a78bfa" stroke-width="2" stroke-linecap="round"/></svg>`,

  demo: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-label="Demo"><rect x="1" y="1" width="7" height="7" rx="2" fill="#3b82f6"/><rect x="10" y="1" width="7" height="7" rx="2" fill="#6366f1"/><rect x="1" y="10" width="7" height="7" rx="2" fill="#22c55e"/><rect x="10" y="10" width="7" height="7" rx="2" fill="#ec4899"/></svg>`,
};

const LABELS = {
  googledrive: 'Google Drive',
  local: 'Local',
  demo: 'Demo',
};

export { LOGOS, LABELS };
