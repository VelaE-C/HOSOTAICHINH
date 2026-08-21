// ============================================================
// utils.js — Hàm tiện ích dùng chung cho mọi module
// ============================================================

export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('vi-VN'));
export const tyi = (n) => (n / 1e9).toFixed(2) + ' tỷ';
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('vi-VN') : '—');

export function toast(msg, type = 'info') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function loading(on, msg) {
  if (on) toast(msg || 'Đang xử lý…', 'info');
}

// Ngưỡng màu ngân sách dùng lại nhiều nơi (Dashboard, Ngân sách)
export function budgetColor(pct) {
  if (pct <= 80) return 'var(--green)';
  if (pct <= 100) return 'var(--amber)';
  return 'var(--red)';
}

// Nhãn trạng thái chuẩn dùng chung cho hợp đồng/bill/tờ trình
export function statusBadge(status) {
  const done = ['active', 'paid', 'closed'];
  const progress = 'pending';
  const danger = 'rejected';
  if (done.includes(status)) return `<span class="badge done">● ${status}</span>`;
  if (status === progress) return `<span class="badge progress">● Đang duyệt</span>`;
  if (status === danger) return `<span class="badge danger">● Từ chối</span>`;
  return `<span class="badge idle">${status}</span>`;
}
