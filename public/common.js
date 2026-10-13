// Shared helpers for every page
window.TP = (() => {
  const kes = (n) => "KES " + Math.round(Number(n) || 0).toLocaleString("en-KE");
  // SQLite returns UTC "YYYY-MM-DD HH:MM:SS" — show in the viewer's local time (EAT in Kenya)
  const parseUtc = (s) => (s ? new Date(s.replace(" ", "T") + "Z") : null);
  const time = (s) => parseUtc(s)?.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) ?? "";
  const dateTime = (s) =>
    parseUtc(s)?.toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) ?? "";
  const ago = (s) => {
    const m = Math.max(0, Math.round((Date.now() - parseUtc(s)) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const tok = localStorage.getItem("tp_staff_token");
    if (tok && (path.startsWith("/api/staff") || path.startsWith("/api/admin"))) headers["x-staff-token"] = tok;
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 2600, iconSvg = "") {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.innerHTML = iconSvg + `<span>${esc(msg)}</span>`;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), ms);
  }

  function sheet(html, { onClose } = {}) {
    // If a sheet is already open, swap its content in place (no re-animation flicker)
    const open = document.querySelector(".sheet");
    if (open) {
      open.innerHTML = `<div class="grab"></div>` + html;
      document.querySelector(".sheet-backdrop").onclick = () => { closeSheet(); onClose?.(); };
      return open;
    }
    const bd = document.createElement("div");
    bd.className = "sheet-backdrop";
    const sh = document.createElement("div");
    sh.className = "sheet";
    sh.setAttribute("role", "dialog");
    sh.innerHTML = `<div class="grab"></div>` + html;
    bd.onclick = () => { closeSheet(); onClose?.(); };
    document.body.append(bd, sh);
    return sh;
  }
  function closeSheet() {
    document.querySelectorAll(".sheet, .sheet-backdrop").forEach((e) => e.remove());
  }

  // Short double-beep for staff alerts (needs one user tap first to unlock audio)
  let audio;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.15, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.15);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.16);
      });
    } catch {}
  }

  // Stroke icons (24px grid). icon("bell", 20) -> inline <svg>
  const ICONS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6"/><path d="M16 12h-6"/><path d="M13 16h-3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
    water: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0Z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    dish: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
    share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  };
  const icon = (name, size = 20, sw = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  return { kes, time, dateTime, ago, esc, api, toast, sheet, closeSheet, beep, icon };
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
