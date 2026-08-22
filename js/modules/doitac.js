// ============================================================
// doitac.js — Đối tác (NCC/NTP). Bất kỳ vai trò nào cũng khai báo được đối tác mới
// (kể cả QS) — chống trùng theo MST, không cho xóa nếu đã dùng trong hợp đồng
// (đã có trigger chặn ở tầng database, module này chỉ ẩn nút xóa cho gọn).
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading } from '../core/utils.js';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: partners, error } = await supabase.from('partners').select('id, name, abbr, mst, type').order('name');
  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  // Đếm số hợp đồng theo từng đối tác — 1 truy vấn duy nhất, gộp lại ở client
  const { data: contractCounts } = await supabase.from('contracts').select('partner_id');
  const countMap = {};
  (contractCounts || []).forEach((c) => (countMap[c.partner_id] = (countMap[c.partner_id] || 0) + 1));

  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-primary" id="btnNew">+ Khai báo đối tác mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Đối tác</th><th>Mã viết tắt</th><th>MST</th><th>Loại</th><th>Số hợp đồng</th></tr></thead><tbody>
    ${partners && partners.length ? partners.map((p) => `<tr class="click" data-id="${p.id}"><td>${p.name}</td><td><span class="code-chip">${p.abbr}</span></td><td class="mono">${p.mst}</td>
    <td><span class="badge ${p.type === 'NCC' ? 'info' : 'done'}">${p.type}</span></td><td>${countMap[p.id] || 0}</td></tr>`).join('') :
    `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có đối tác nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, () => render(container, user))));
}

export async function openDetail(id, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: p } = await supabase.from('partners').select('*').eq('id', id).single();
  if (!p) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được đối tác.</div>`;
    return;
  }
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, status, contract_type').eq('partner_id', id).order('created_at', { ascending: false });

  const statusVN = { draft: 'Nháp', pending: 'Đang duyệt', active: 'Có hiệu lực', rejected: 'Từ chối', closed: 'Đã thanh lý' };

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${p.name}</div><div class="meta">${p.type} · Mã ${p.abbr}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div class="kv">
        <div class="k">Mã số thuế (MST)</div><div class="v mono">${p.mst}</div>
        <div class="k">Người đại diện</div><div class="v">${p.representative || '—'}</div>
        <div class="k">Điện thoại</div><div class="v">${p.phone || '—'}</div>
        <div class="k">Địa chỉ</div><div class="v">${p.address || '—'}</div>
        <div class="k">Tài khoản NH</div><div class="v mono">${p.bank_account || '—'}</div>
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hợp đồng đã ký (${contracts?.length || 0})</div>
      <div class="card" style="padding:0;overflow:hidden">
        ${contracts && contracts.length ? `<table><thead><tr><th>Số hợp đồng</th><th>Loại</th><th>Giá trị</th><th>Trạng thái</th></tr></thead><tbody>
        ${contracts.map((c) => `<tr><td class="mono">${c.doc_number}</td><td>${c.contract_type}</td><td class="mono">${fmt(c.value)}</td><td><span class="badge idle">${statusVN[c.status] || c.status}</span></td></tr>`).join('')}
        </tbody></table>` : `<div class="empty-note">Chưa có hợp đồng nào</div>`}
      </div>
      <div style="font-size:11.5px;color:var(--gray4);margin-top:8px">🔒 Đối tác đã dùng trong ít nhất 1 hợp đồng thì không thể xóa khỏi hệ thống.</div>
    </div>`;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Khai báo đối tác mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nếu MST đã tồn tại trong hệ thống (dù do ai khai báo, dự án nào), hệ thống tự dùng lại đối tác đó — không tạo bản ghi trùng.</div>
      <div style="margin-bottom:13px"><label class="form-label">Mã số thuế (MST) *</label>
        <input type="text" id="fMst" class="form-input" placeholder="VD: 0301234567">
        <div id="mstCheckMsg" style="font-size:12px;margin-top:5px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đối tác *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mã viết tắt * (dùng trong số hợp đồng)</label><input type="text" id="fAbbr" class="form-input" placeholder="VD: DongA"></div>
      <div style="margin-bottom:13px"><label class="form-label">Loại *</label>
        <select id="fType" class="form-input"><option value="NCC">NCC — Nhà cung cấp</option><option value="NTP">NTP — Nhà thầu phụ</option></select></div>
      <div style="margin-bottom:13px"><label class="form-label">Người đại diện</label><input type="text" id="fRep" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Địa chỉ</label><input type="text" id="fAddress" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tài khoản ngân hàng</label><input type="text" id="fBank" class="form-input"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu đối tác</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  let existingMatch = null;
  modal.querySelector('#fMst').addEventListener('blur', async (e) => {
    const mst = e.target.value.trim();
    const msgEl = modal.querySelector('#mstCheckMsg');
    existingMatch = null;
    if (!mst) return (msgEl.innerHTML = '');
    const { data } = await supabase.from('partners').select('id, name, abbr').eq('mst', mst).maybeSingle();
    if (data) {
      existingMatch = data;
      msgEl.innerHTML = `<span style="color:var(--amber)">⚠️ MST này đã có: <b>${data.name}</b> (${data.abbr}) — bấm Lưu sẽ dùng lại đối tác này, không tạo mới.</span>`;
    } else {
      msgEl.innerHTML = `<span style="color:var(--green)">✓ MST chưa tồn tại, sẽ tạo đối tác mới.</span>`;
    }
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    if (existingMatch) {
      toast(`Đã dùng lại đối tác có sẵn: ${existingMatch.name}`, 'info');
      return closeModal(modal, onClose);
    }
    const mst = modal.querySelector('#fMst').value.trim();
    const name = modal.querySelector('#fName').value.trim();
    const abbr = modal.querySelector('#fAbbr').value.trim();
    const type = modal.querySelector('#fType').value;
    if (!mst || !name || !abbr) return toast('Điền đủ MST, Tên, Mã viết tắt', 'error');

    loading(true);
    const { error } = await supabase.from('partners').insert({
      mst, name, abbr, type,
      representative: modal.querySelector('#fRep').value.trim() || null,
      phone: modal.querySelector('#fPhone').value.trim() || null,
      address: modal.querySelector('#fAddress').value.trim() || null,
      bank_account: modal.querySelector('#fBank').value.trim() || null,
      created_by: user.id,
    });
    if (error) return toast('Lỗi lưu đối tác: ' + error.message, 'error');
    toast('Đã lưu đối tác mới', 'success');
    closeModal(modal, onClose);
  });
}

function ensureModal() {
  let modal = document.getElementById('module-overlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'module-overlay';
    modal.className = 'overlay';
    modal.innerHTML = `<div class="panel-box"></div>`;
    document.body.appendChild(modal);
  }
  return modal;
}
function showModal(modal, onClose) {
  modal.classList.add('show');
  // Cố tình KHÔNG đóng khi bấm ra ngoài — tránh mất dữ liệu đang nhập nếu lỡ tay bấm trượt.
  // Chỉ đóng bằng nút X (hoặc nút Hủy/nút quay lại chi tiết).
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  if (onClose) onClose();
}
