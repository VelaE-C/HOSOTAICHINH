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
  if (status === 'cancelled') return `<span class="badge idle" style="text-decoration:line-through">Đã hủy</span>`;
  if (done.includes(status)) return `<span class="badge done">● ${status}</span>`;
  if (status === progress) return `<span class="badge progress">● Đang duyệt</span>`;
  if (status === danger) return `<span class="badge danger">● Từ chối</span>`;
  return `<span class="badge idle">${status}</span>`;
}

// ============================================================
// Ô NHẬP TIỀN CÓ DẤU CHẤM NGĂN CÁCH (VD gõ 250000000 -> tự hiện 250.000.000)
// Cách dùng: đặt input type="text" class="form-input money-input", rồi gọi
// wireMoneyInputs(modal) đúng 1 lần sau khi showModal — áp dụng luôn cho cả
// những dòng thêm động sau này (chia mã ngân sách...) nhờ dùng event delegation.
// Khi đọc giá trị để tính/lưu, dùng parseMoneyInput(el.value) thay vì Number(el.value).
// ============================================================

export function formatMoneyInput(raw) {
  const str = String(raw ?? '');
  const isNegative = str.trim().startsWith('-');
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return isNegative ? '-' : '';
  const formatted = Number(digits).toLocaleString('vi-VN');
  return isNegative ? '-' + formatted : formatted;
}

export function parseMoneyInput(raw) {
  const str = String(raw ?? '');
  const isNegative = str.trim().startsWith('-');
  const digits = str.replace(/[^\d]/g, '');
  const num = Number(digits) || 0;
  return isNegative ? -num : num;
}

export function wireMoneyInputs(container) {
  if (container.dataset.moneyWired) return; // tránh gắn trùng nếu lỡ gọi 2 lần
  container.dataset.moneyWired = '1';
  container.addEventListener('input', (e) => {
    if (!e.target.classList || !e.target.classList.contains('money-input')) return;
    const el = e.target;
    const cursorFromEnd = el.value.length - el.selectionStart;
    el.value = formatMoneyInput(el.value);
    const pos = Math.max(0, el.value.length - cursorFromEnd);
    el.setSelectionRange(pos, pos);
  });
}

// ============================================================
// TÍCH HỢP NÚT BACK / VUỐT LÙI (ĐIỆN THOẠI) VỚI MODAL ĐANG MỞ
// Không có cơ chế này, Back sẽ chỉ đổi URL tab phía sau mà không đóng form
// đang che phía trên — trông như bị "kẹt màn hình".
// Cách dùng: gọi pushModalHistory() trong showModal(), popModalHistory()
// trong closeModal(); gọi initModalBackHandler() đúng 1 lần lúc khởi động app.
// ============================================================
export function pushModalHistory(hashOverride) {
  if (!window.__velaModalOpen) {
    window.__velaModalOpen = true;
    if (hashOverride) {
      history.pushState({ velaModal: true }, '', '#' + hashOverride);
    } else {
      history.pushState({ velaModal: true }, '');
    }
  }
}

export function popModalHistory() {
  if (window.__velaModalOpen) {
    window.__velaModalOpen = false;
    history.back();
  }
}

export function initModalBackHandler() {
  window.addEventListener('popstate', () => {
    if (window.__velaModalOpen) {
      window.__velaModalOpen = false;
      document.querySelectorAll('.overlay.show').forEach((el) => el.classList.remove('show'));
    }
  });
}
