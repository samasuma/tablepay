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
  function toast(msg, ms = 2600) {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
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

  return { kes, time, dateTime, ago, esc, api, toast, sheet, closeSheet, beep };
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
