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

// ============================================================
// Ô CHỌN CÓ GÕ ĐỂ LỌC (COMBOBOX) — thay cho <select> dài (Đối tác, ...).
// Gõ vài ký tự (không cần gõ dấu) là lọc theo tên hoặc phần phụ (VD MST);
// chọn bằng chuột hoặc bàn phím (↑/↓, Enter), Esc để đóng danh sách.
//
// Cách dùng (3 bước, giữ đúng hành vi như <select> cũ để không phải sửa
// chỗ khác đang đọc/gán giá trị):
//   1. Chèn HTML:
//        searchSelectHtml('fPartner', partners, bill?.partner_id, {
//          placeholder: 'Gõ tên hoặc MST để tìm...',
//          labelFn: (p) => p.name,
//          subFn:   (p) => `(MST ${p.mst})`,
//        })
//      -> sinh ra 1 input hiện/gõ tìm + 1 input ẩn id="fPartner" giữ giá
//         trị thật (id đối tác) + khung danh sách kết quả.
//   2. Sau khi đã chèn vào DOM (sau showModal): gọi initSearchSelect(modal,
//      'fPartner', partners, { labelFn, subFn, onChange }) — labelFn/subFn
//      PHẢI giống bước 1. onChange (không bắt buộc) nhận đúng item vừa chọn.
//   3. Đọc giá trị: modal.querySelector('#fPartner').value — y hệt select
//      thường. Gán giá trị bằng code (VD tự điền Đối tác theo Hợp đồng đã
//      chọn): dùng setSearchSelectValue(modal, 'fPartner', partners, id,
//      labelFn, subFn) thay vì gán thẳng .value, để ô hiển thị cập nhật
//      đúng theo tên/MST tương ứng.
//   Sự kiện 'change' trên input ẩn #fPartner CHỈ tự bắn khi người dùng bấm
//   chọn tay (giống select thật) — gán bằng setSearchSelectValue thì không
//   tự bắn, đúng như hành vi select.value = x trước đây.
// ============================================================

export function normalizeSearchText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // bỏ dấu tiếng Việt — gõ không dấu vẫn tìm được
}

function searchSelectLabel(it, labelFn, subFn) {
  const main = labelFn(it);
  const sub = subFn(it);
  return sub ? `${main} ${sub}` : main;
}

export function searchSelectHtml(id, items, selectedValue, opts = {}) {
  const placeholder = opts.placeholder || '-- Gõ để tìm --';
  const labelFn = opts.labelFn || ((it) => it.name);
  const subFn = opts.subFn || (() => '');
  const selected = (items || []).find((it) => it.id === selectedValue);
  const displayVal = selected ? searchSelectLabel(selected, labelFn, subFn) : '';
  return `<div class="search-select" style="position:relative">
    <input type="text" class="form-input search-select-input" id="${id}-search" autocomplete="off" placeholder="${placeholder}" value="${displayVal.replace(/"/g, '&quot;')}">
    <input type="hidden" id="${id}" value="${selectedValue || ''}">
    <div class="search-select-list" id="${id}-list" style="display:none;position:absolute;z-index:50;left:0;right:0;top:100%;max-height:240px;overflow-y:auto;background:#fff;border:1px solid var(--gray2);border-radius:8px;margin-top:4px;box-shadow:0 4px 14px rgba(0,0,0,.14)"></div>
  </div>`;
}

export function initSearchSelect(container, id, items, opts = {}) {
  const labelFn = opts.labelFn || ((it) => it.name);
  const subFn = opts.subFn || (() => '');
  const onChange = opts.onChange || (() => {});
  const searchInput = container.querySelector(`#${id}-search`);
  const hiddenInput = container.querySelector(`#${id}`);
  const list = container.querySelector(`#${id}-list`);
  if (!searchInput || !hiddenInput || !list) return;

  let filtered = items || [];
  let activeIndex = -1;

  function renderList() {
    if (!filtered.length) {
      list.innerHTML = `<div style="padding:10px 12px;color:var(--gray4);font-size:13px">Không tìm thấy</div>`;
    } else {
      list.innerHTML = filtered
        .map(
          (it, i) =>
            `<div class="search-select-opt" data-idx="${i}" style="padding:9px 12px;cursor:pointer;font-size:14px;${i === activeIndex ? 'background:var(--gray1)' : ''}">${labelFn(it)}${
              subFn(it) ? ` <span style="color:var(--gray4);font-size:12px">${subFn(it)}</span>` : ''
            }</div>`
        )
        .join('');
    }
    list.style.display = 'block';
  }

  function closeList() {
    list.style.display = 'none';
    activeIndex = -1;
  }

  function selectItem(it) {
    hiddenInput.value = it.id;
    searchInput.value = searchSelectLabel(it, labelFn, subFn);
    closeList();
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    onChange(it);
  }

  searchInput.addEventListener('focus', () => {
    filtered = items || [];
    activeIndex = -1;
    renderList();
  });

  searchInput.addEventListener('input', () => {
    const q = normalizeSearchText(searchInput.value);
    filtered = !q ? items || [] : (items || []).filter((it) => normalizeSearchText(labelFn(it)).includes(q) || normalizeSearchText(subFn(it)).includes(q));
    activeIndex = -1;
    if (!searchInput.value) hiddenInput.value = ''; // xóa hết chữ trong ô = bỏ chọn
    renderList();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (list.style.display === 'none' && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      filtered = items || [];
      renderList();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) selectItem(filtered[activeIndex]);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  // mousedown (không phải click) để chạy TRƯỚC sự kiện blur của ô input,
  // nếu không ô input sẽ đóng danh sách trước khi kịp ghi nhận cú bấm chọn
  list.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.search-select-opt');
    if (!opt) return;
    const it = filtered[Number(opt.dataset.idx)];
    if (it) selectItem(it);
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => {
      closeList();
      // rời ô mà chưa chọn đúng mục nào khớp chữ đang gõ dở -> khôi phục lại
      // đúng tên của giá trị đang lưu (hoặc để trống nếu chưa chọn gì)
      const current = (items || []).find((it) => it.id === hiddenInput.value);
      searchInput.value = current ? searchSelectLabel(current, labelFn, subFn) : '';
    }, 150);
  });
}

export function setSearchSelectValue(container, id, items, value, labelFn = (it) => it.name, subFn = () => '') {
  const hiddenInput = container.querySelector(`#${id}`);
  const searchInput = container.querySelector(`#${id}-search`);
  if (!hiddenInput) return;
  hiddenInput.value = value || '';
  if (searchInput) {
    const it = (items || []).find((x) => x.id === value);
    searchInput.value = it ? searchSelectLabel(it, labelFn, subFn) : '';
  }
}
