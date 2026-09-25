// ============================================================
// thucthu.js — Thực thu sản lượng từ Chủ đầu tư (CĐT)
//
// Ghi nhận tiền CĐT thực trả về theo từng đợt claim. KHÔNG qua luồng phê duyệt:
// đây là số liệu ghi nhận thực tế, không phải đề nghị chi tiền. Bù lại, mỗi dòng
// bắt buộc có chứng từ đính kèm, và database tự ghi ai nhập / ai sửa / lúc nào
// (trigger trg_stamp_owner_receipt) — giao diện KHÔNG gửi 2 trường đó lên.
//
// Quyền: chỉ QLCPHD_CV / QLCPHD_TP / Admin nhập và sửa; xóa thì chỉ QLCPHD_TP và
// Admin. Luật thật nằm ở RLS bảng owner_receipts — phần ẩn/hiện nút dưới đây chỉ
// để đỡ bấm nhầm, KHÔNG phải cơ chế bảo vệ.
//
// Số liệu nhập TRƯỚC THUẾ, để cùng gốc so sánh với cột Chi phí dự án trên
// Dashboard (cột đó cũng quy về trước thuế). Cột có VAT do database tự tính.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, fmtDate, fmtDateTime, toast, loading, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory, IS_MOBILE } from '../core/utils.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';
import { exportListExcel } from './bctcExport.js';

const OWNER_TYPE = 'owner_receipt'; // phải khớp đúng nhánh đã thêm trong can_see_document()
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let VIEW_PROJECT = 'ALL';

const canEdit = (user) => (user.roles || []).some((r) => ['QLCPHD_CV', 'QLCPHD_TP', 'Admin'].includes(r));
const canDelete = (user) => (user.roles || []).some((r) => ['QLCPHD_TP', 'Admin'].includes(r));

// Kỳ lưu dạng ngày 01 của tháng -> hiện "09/2026"
const fmtPeriod = (d) => (d ? `${String(new Date(d).getMonth() + 1).padStart(2, '0')}/${new Date(d).getFullYear()}` : '—');
// <input type="month"> cần "2026-09"
const toMonthInput = (d) => (d ? new Date(d).toISOString().slice(0, 7) : '');
const fromMonthInput = (v) => (v ? `${v}-01` : null);

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: rows, error }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    supabase
      .from('owner_receipts')
      .select('*, projects(code, name), creator:created_by(full_name), editor:updated_by(full_name)')
      .order('project_id')
      .order('claim_no'),
  ]);

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${esc(error.message)}</div>`;
    return;
  }

  const list = VIEW_PROJECT === 'ALL' ? rows || [] : (rows || []).filter((r) => r.project_id === VIEW_PROJECT);
  const tong = list.reduce((s, r) => s + Number(r.amount_before_vat || 0), 0);
  const tongVat = list.reduce((s, r) => s + Number(r.amount_with_vat || 0), 0);
  const editable = canEdit(user);

  container.innerHTML = `
    <div style="display:flex;${IS_MOBILE ? 'flex-direction:column;align-items:stretch' : 'justify-content:space-between;flex-wrap:wrap'};margin-bottom:12px;gap:10px">
      <select class="btn btn-secondary" id="projFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : 'min-width:320px'}">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name)}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;${IS_MOBILE ? 'flex-direction:column' : ''}">
        <button class="btn btn-secondary" id="btnExport">📊 Xuất Excel</button>
        ${editable ? `<button class="btn btn-primary" id="btnNew">+ Ghi nhận đợt claim</button>` : ''}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="card-sub" style="margin:0">Số đợt claim đã ghi nhận</div><div class="stat-num">${list.length}</div></div>
        <div><div class="card-sub" style="margin:0">Tổng thực thu (trước thuế)</div><div class="stat-num teal">${fmt(tong)} ₫</div></div>
        <div><div class="card-sub" style="margin:0">Tổng thực thu (có VAT)</div><div class="stat-num">${fmt(tongVat)} ₫</div></div>
      </div>
    </div>

    ${!editable ? `<div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">🔒 Chỉ phòng QLCP&HĐ nhập được số liệu ở tab này — bạn chỉ xem.</div>` : ''}

    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Dự án</th><th>Đợt</th><th>Kỳ</th>
        <th style="text-align:right">Trước thuế</th><th>VAT</th><th style="text-align:right">Có VAT</th>
        <th>Ngày CĐT trả</th><th>Ghi chú</th><th>Người nhập</th>
      </tr></thead><tbody>
      ${list.length
        ? list
            .map(
              (r) => `<tr class="click" data-id="${r.id}" style="cursor:pointer">
          <td><span class="code-chip" title="${esc(r.projects?.name)}">${esc(r.projects?.code || '—')}</span></td>
          <td class="mono" style="font-weight:700">${r.claim_no}</td>
          <td class="mono">${fmtPeriod(r.period_month)}</td>
          <td class="mono" style="text-align:right;font-weight:700">${fmt(r.amount_before_vat)}</td>
          <td class="mono">${Number(r.vat_rate)}%</td>
          <td class="mono" style="text-align:right;color:var(--gray6)">${fmt(r.amount_with_vat)}</td>
          <td>${fmtDate(r.paid_date)}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gray6)" title="${esc(r.note)}">${esc(r.note || '—')}</td>
          <td style="font-size:11.5px;color:var(--gray5)">${esc(r.creator?.full_name || '—')}</td>
        </tr>`,
            )
            .join('')
        : `<tr><td colspan="9" style="text-align:center;color:var(--gray4);padding:22px">Chưa ghi nhận đợt claim nào${VIEW_PROJECT !== 'ALL' ? ' cho dự án này' : ''}</td></tr>`}
      </tbody></table></div>
    </div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew')?.addEventListener('click', () => openForm(null, projects, user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const rec = list.find((x) => x.id === tr.dataset.id);
      if (rec) openForm(rec, projects, user, () => render(container, user));
    }),
  );

  container.querySelector('#btnExport').addEventListener('click', () =>
    exportListExcel(
      {
        subtitle: 'THỰC THU SẢN LƯỢNG TỪ CHỦ ĐẦU TƯ',
        note: VIEW_PROJECT === 'ALL' ? 'Tất cả dự án' : `Dự án: ${(projects || []).find((p) => p.id === VIEW_PROJECT)?.code || ''}`,
        columns: [
          { key: 'duan', header: 'Dự án', width: 18 },
          { key: 'dot', header: 'Đợt', width: 8, center: true },
          { key: 'ky', header: 'Kỳ', width: 12, center: true },
          { key: 'truocthue', header: 'Trước thuế', width: 20, money: true },
          { key: 'vat', header: 'VAT (%)', width: 10, center: true },
          { key: 'covat', header: 'Có VAT', width: 20, money: true },
          { key: 'ngaytra', header: 'Ngày CĐT trả', width: 15, center: true },
          { key: 'ghichu', header: 'Ghi chú', width: 34 },
          { key: 'nguoinhap', header: 'Người nhập', width: 20 },
        ],
        rows: list.map((r) => ({
          duan: r.projects?.code || '',
          dot: r.claim_no,
          ky: fmtPeriod(r.period_month),
          truocthue: Number(r.amount_before_vat || 0),
          vat: Number(r.vat_rate || 0),
          covat: Number(r.amount_with_vat || 0),
          ngaytra: fmtDate(r.paid_date),
          ghichu: r.note || '',
          nguoinhap: r.creator?.full_name || '',
        })),
        fileBase: 'Thuc_thu_CDT',
        sheetName: 'Thực thu CĐT',
      },
      (msg) => toast(msg, 'error'),
    ),
  );
}

// ============================================================
// Form ghi nhận / sửa 1 đợt claim
// rec = null -> tạo mới
// ============================================================
async function openForm(rec, projects, user, onClose) {
  const modal = ensureModal();
  const isNew = !rec;
  const editable = canEdit(user);

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>${isNew ? 'Ghi nhận đợt claim mới' : `Đợt ${rec.claim_no} — ${esc(rec.projects?.code || '')}`}</div>
      <div style="display:flex;gap:6px;align-items:center">
        ${!isNew && canDelete(user) ? `<button class="btn btn-sm btn-danger" id="btnDelete">🗑️ Xóa</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nhập số <b>TRƯỚC THUẾ</b>. Cột có VAT hệ thống tự tính, không nhập tay. Mục này không qua luồng duyệt — bù lại nên đính kèm chứng từ để sau này đối chiếu.</div>

      <div style="margin-bottom:13px"><label class="form-label">Dự án *</label>
        <select id="fProject" class="form-input" ${isNew ? '' : 'disabled style="background:var(--gray1)"'}>
          ${(projects || []).map((p) => `<option value="${p.id}" ${rec?.project_id === p.id ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name)}</option>`).join('')}
        </select>
        ${isNew ? '' : '<div style="font-size:11px;color:var(--gray4);margin-top:4px">Không đổi được dự án của đợt đã ghi nhận — nếu nhập nhầm dự án thì xóa dòng này rồi tạo lại.</div>'}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Đợt claim *</label>
          <input type="number" id="fClaim" class="form-input" min="1" value="${rec?.claim_no ?? ''}">
          <div id="claimNote" style="font-size:11.5px;margin-top:4px"></div></div>
        <div><label class="form-label">Kỳ (tháng)</label>
          <input type="month" id="fPeriod" class="form-input" value="${toMonthInput(rec?.period_month)}"></div>
      </div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Số tiền TRƯỚC thuế (₫) *</label>
          <input type="text" inputmode="numeric" id="fAmount" class="form-input money-input" value="${formatMoneyInput(rec?.amount_before_vat || 0)}"></div>
        <div><label class="form-label">VAT (%)</label>
          <input type="number" id="fVat" class="form-input" step="0.1" value="${rec?.vat_rate ?? 8}"></div>
      </div>

      <div class="card" style="background:var(--gray1);border:1px solid var(--gray2);padding:10px 14px;margin-bottom:13px">
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span style="color:var(--gray6)">Số tiền có VAT (tự tính)</span>
          <b class="mono" id="previewVat">—</b>
        </div>
      </div>

      <div style="margin-bottom:13px"><label class="form-label">Ngày CĐT thanh toán</label>
        <input type="date" id="fPaidDate" class="form-input" value="${rec?.paid_date || ''}"></div>

      <div style="margin-bottom:13px"><label class="form-label">Ghi chú</label>
        <textarea id="fNote" class="form-input" rows="3" placeholder="VD: Claim đợt 5 tháng 9 — CĐT giữ lại 5% bảo hành, đã trừ tạm ứng">${esc(rec?.note || '')}</textarea></div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chứng từ đính kèm</div>
      <div class="card" id="attachArea" style="padding:12px 14px"></div>

      ${!isNew ? `<div style="font-size:11.5px;color:var(--gray4);margin-top:12px;line-height:1.7">
        Người nhập: <b>${esc(rec.creator?.full_name || '—')}</b> · ${fmtDateTime(rec.created_at)}
        ${rec.updated_by ? `<br>Sửa lần cuối: <b>${esc(rec.editor?.full_name || '—')}</b> · ${fmtDateTime(rec.updated_at)}` : ''}
      </div>` : ''}
    </div>
    ${editable ? `<div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 ${isNew ? 'Lưu đợt claim' : 'Lưu thay đổi'}</button></div>` : ''}
  </div>`;

  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // Xem trước số có VAT ngay khi gõ — khớp đúng công thức database đang dùng
  function refreshPreview() {
    const amount = parseMoneyInput(modal.querySelector('#fAmount').value);
    const vat = Number(modal.querySelector('#fVat').value) || 0;
    modal.querySelector('#previewVat').textContent = fmt(Math.round(amount * (1 + vat / 100))) + ' ₫';
  }
  modal.addEventListener('input', refreshPreview);
  refreshPreview();

  // Soi trùng đợt NGAY LÚC GÕ — database đã chặn bằng ràng buộc duy nhất, nhưng để
  // người dùng nhập xong cả form rồi mới báo lỗi thì quá muộn.
  let claimTimer = null;
  async function checkClaimDup() {
    const note = modal.querySelector('#claimNote');
    const projectId = modal.querySelector('#fProject').value;
    const claimNo = Number(modal.querySelector('#fClaim').value);
    if (!projectId || !claimNo) return (note.innerHTML = '');
    if (!isNew && claimNo === rec.claim_no) return (note.innerHTML = '');
    const { data } = await supabase.from('owner_receipts').select('id').eq('project_id', projectId).eq('claim_no', claimNo).limit(1);
    note.innerHTML = data && data.length
      ? `<span style="color:var(--red);font-weight:600">✕ Đợt ${claimNo} của dự án này đã được ghi nhận rồi — lưu sẽ bị chặn.</span>`
      : `<span style="color:var(--green,#16A34A)">✓ Đợt này chưa có.</span>`;
  }
  modal.querySelector('#fClaim').addEventListener('input', () => {
    clearTimeout(claimTimer);
    claimTimer = setTimeout(checkClaimDup, 350);
  });
  modal.querySelector('#fProject').addEventListener('change', checkClaimDup);

  // Đính kèm: dòng ĐÃ có thì gắn thẳng; dòng MỚI chưa có id nên chọn tạm, lưu xong mới tải lên
  let filePicker = null;
  if (isNew) {
    filePicker = renderFilePicker(modal.querySelector('#attachArea'));
  } else {
    renderAttachments(modal.querySelector('#attachArea'), OWNER_TYPE, rec.id, user.id, editable, false, 0);
  }

  modal.querySelector('#btnDelete')?.addEventListener('click', async () => {
    if (!confirm(`Xóa đợt claim ${rec.claim_no} của dự án ${rec.projects?.code || ''}?\n\nDữ liệu sẽ mất hẳn, không hoàn tác được.`)) return;
    loading(true);
    const { error } = await supabase.from('owner_receipts').delete().eq('id', rec.id);
    if (error) return toast('Lỗi xóa: ' + error.message, 'error');
    toast('Đã xóa đợt claim', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnSave')?.addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const claim_no = Number(modal.querySelector('#fClaim').value);
    const period_month = fromMonthInput(modal.querySelector('#fPeriod').value);
    const amount_before_vat = parseMoneyInput(modal.querySelector('#fAmount').value);
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const paid_date = modal.querySelector('#fPaidDate').value || null;
    const note = modal.querySelector('#fNote').value.trim() || null;

    if (!project_id || !claim_no) return toast('Chọn Dự án và điền Đợt claim', 'error');
    if (!amount_before_vat) return toast('Điền số tiền trước thuế', 'error');

    loading(true);
    // CỐ Ý không gửi created_by/updated_by — trigger bên database tự ghi, không ai giả được
    const payload = { project_id, claim_no, period_month, amount_before_vat, vat_rate, paid_date, note };

    if (isNew) {
      const { data: created, error } = await supabase.from('owner_receipts').insert(payload).select('id').single();
      if (error) {
        if (error.message.includes('owner_receipts_project_claim_unique') || error.message.includes('duplicate key')) {
          return toast(`Đợt ${claim_no} của dự án này đã được ghi nhận rồi — mở dòng đó ra sửa, đừng tạo trùng.`, 'error');
        }
        return toast('Lỗi lưu: ' + error.message, 'error');
      }
      await uploadStagedFiles(filePicker.getFiles(), OWNER_TYPE, created.id, user.id);
      toast('Đã ghi nhận đợt claim', 'success');
    } else {
      const { error } = await supabase.from('owner_receipts').update(payload).eq('id', rec.id);
      if (error) {
        if (error.message.includes('owner_receipts_project_claim_unique') || error.message.includes('duplicate key')) {
          return toast(`Đợt ${claim_no} của dự án này đã có dòng khác dùng rồi.`, 'error');
        }
        return toast('Lỗi lưu: ' + error.message, 'error');
      }
      toast('Đã lưu thay đổi', 'success');
    }
    closeModal(modal, onClose);
  });
}

// ---- tiện ích modal dùng chung trong module này ----
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
  modal.scrollTop = 0;
  pushModalHistory();
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
