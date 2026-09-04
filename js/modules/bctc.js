// ============================================================
// bctc.js — Module Báo Cáo Tài Chính (BCTC), thay thế Ngân sách + Hợp đồng đầu ra.
// Mỗi Rev là 1 hồ sơ duyệt hoàn chỉnh (giống Hợp đồng) — QS trình, BGD duyệt cả Rev
// 1 lần (không duyệt từng dòng). Rev mới có thể kế thừa toàn bộ dòng từ Rev trước.
//
// Cấu trúc: Hàng A (Doanh thu, luôn nhập tay) — Hàng B (Chi phí, chia nhóm B.1/B.2...,
// mỗi nhóm có nhiều dòng chi tiết B.x.0y) — Hàng C (Lợi nhuận = A-B, tự tính, không lưu).
// Mỗi dòng chi tiết CÓ THỂ link 1 Hợp đồng thật (tự tính Giá trị dự trù + Dữ liệu
// thanh toán từ dữ liệu gốc, không nhập tay) hoặc để trống link (nhập tay hoàn toàn).
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory, normalizeSearchText, paginationHtml, wirePagination, PAGE_SIZE, IS_MOBILE } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, loadStepPreview } from '../core/approvalUI.js';

let VIEW_PROJECT = 'ALL';
let VIEW_PAGE = 1;

// ============================================================
// Tính "Giá trị dự trù" và "Dữ liệu thanh toán" cho 1 dòng — CÓ link hợp đồng thì
// lấy tươi từ dữ liệu gốc (tách VAT), KHÔNG link thì lấy đúng số đã nhập tay.
// latestPaidByContract: map contract_id -> { val_d, vat_rate } của bill "paid" mới nhất.
// ============================================================
function lineForecast(line, contractsMap) {
  if (line.contract_id) {
    const c = contractsMap[line.contract_id];
    if (!c) return 0;
    const vatRate = (c.vat_rate ?? 8) / 100;
    return Number(c.value) / (1 + vatRate);
  }
  return Number(line.forecast_value_manual) || 0;
}
function linePayment(line, latestPaidByContract) {
  if (line.contract_id) {
    const b = latestPaidByContract[line.contract_id];
    if (!b) return 0;
    const vatRate = (b.vat_rate ?? 8) / 100;
    return Number(b.val_d) / (1 + vatRate);
  }
  return Number(line.payment_data_manual) || 0;
}

// Gộp toàn bộ số liệu 1 Rev — dùng chung cho danh sách, chi tiết, và xem trước lúc nhập
function summarizeRev(lines, contractsMap, latestPaidByContract) {
  let totalA = 0, totalB = 0;
  const groups = {}; // B.1, B.2... -> tổng nhóm đó
  (lines || []).forEach((l) => {
    const forecast = lineForecast(l, contractsMap);
    if (l.item_code === 'A' || l.item_code.startsWith('A.')) {
      totalA += forecast;
    } else if (l.level === 2) {
      totalB += forecast;
      groups[l.parent_code] = (groups[l.parent_code] || 0) + forecast;
    }
  });
  return { totalA, totalB, totalC: totalA - totalB, groups };
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống.</div>`;
    return;
  }

  const { data: revs, error } = await (VIEW_PROJECT !== 'ALL'
    ? supabase.from('bctc_revisions').select('id, doc_number, rev_no, status, current_step, project_id, created_at, projects(code, name)').eq('project_id', VIEW_PROJECT)
    : supabase.from('bctc_revisions').select('id, doc_number, rev_no, status, current_step, project_id, created_at, projects(code, name)')
  ).neq('status', 'cancelled').order('created_at', { ascending: false });

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  const sorted = [...(revs || [])].sort((a, b) => {
    const ad = a.status === 'active' ? 1 : 0;
    const bd = b.status === 'active' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  container.innerHTML = `
    <div style="display:flex;${IS_MOBILE ? 'flex-direction:column;align-items:stretch' : 'justify-content:space-between;flex-wrap:wrap'};margin-bottom:12px;gap:10px">
      <select class="btn btn-secondary" id="projFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${projects.map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btnNew" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">+ Trình BCTC mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto"><table><thead><tr><th>Dự án</th><th>Rev</th><th>Trạng thái</th></tr></thead><tbody id="revTbody"></tbody></table></div>
      <div id="revPagination"></div>
    </div>`;

  function draw() {
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    VIEW_PAGE = Math.min(Math.max(1, VIEW_PAGE), totalPages);
    const pageItems = sorted.slice((VIEW_PAGE - 1) * PAGE_SIZE, VIEW_PAGE * PAGE_SIZE);
    container.querySelector('#revTbody').innerHTML = pageItems.length
      ? pageItems.map((r) => `<tr class="click" data-id="${r.id}"><td>${r.projects?.name || '—'}</td><td class="mono">Rev${String(r.rev_no).padStart(2, '0')}</td><td>${statusBadge(r.status)}</td></tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;color:var(--gray4);padding:20px">Chưa có Báo cáo tài chính nào</td></tr>`;
    container.querySelector('#revPagination').innerHTML = paginationHtml(VIEW_PAGE, sorted.length);
    wirePagination(container.querySelector('#revPagination'), VIEW_PAGE, sorted.length, (p) => {
      VIEW_PAGE = p;
      draw();
    });
    container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
  }

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    VIEW_PAGE = 1;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  draw();
}

// ============================================================
// CHI TIẾT — xem báo cáo đầy đủ + luồng duyệt
// ============================================================
export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box" style="max-width:1400px;width:97%"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose, `bctc/${id}`);

  const { data: rev } = await supabase.from('bctc_revisions').select('*, projects(name), document_templates(name), users!created_by(full_name)').eq('id', id).single();
  if (!rev) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ (có thể không còn quyền xem).</div>`;
    return;
  }
  const { data: lines } = await supabase.from('bctc_lines').select('*, partners(name)').eq('revision_id', id).order('item_code');
  const { contractsMap, latestPaidByContract } = await loadFinancialData(rev.project_id, lines || []);
  const { data: partnersList } = await supabase.from('partners').select('id, name');
  const partnersMap = Object.fromEntries((partnersList || []).map((p) => [p.id, p.name]));
  const sum = summarizeRev(lines || [], contractsMap, latestPaidByContract);

  const { assignments, logs } = await loadApprovalState('bctc', id);
  const preview = rev.status === 'pending' ? await loadStepPreview(rev.project_id, rev.template_id, rev.current_step) : {};

  const canEditNow = rev.created_by === user.id && ['draft', 'rejected'].includes(rev.status);
  const isAdmin = (user.roles || []).includes('Admin');
  const canCancel = isAdmin && ['draft', 'rejected'].includes(rev.status);
  // Đang "lưu tạm" (Nháp, chưa từng trình) — chủ hồ sơ tự xóa HẲN được, không cần
  // Admin, không cần qua "Hủy" (Hủy chỉ đổi trạng thái, vẫn giữ lại bản ghi).
  const canDelete = rev.created_by === user.id && rev.status === 'draft';

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${rev.projects?.name || '—'}</div><div class="meta mono">${rev.doc_number}</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        ${canDelete ? `<button class="btn btn-sm btn-danger" id="btnDelete">🗑️ Xóa (đang lưu tạm)</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm btn-danger" id="btnCancel">🗑️ Hủy hồ sơ</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      <div class="kv">
        <div class="k">Trạng thái</div><div class="v">${statusBadge(rev.status)}</div>
        <div class="k">Ghi chú</div><div class="v">${rev.note || '—'}</div>
      </div>
      ${readOnlyReportTableHtml(lines || [], contractsMap, latestPaidByContract, partnersMap, sum.totalA, sum.totalB)}
      <div class="card" style="background:var(--gray1);border:1px solid var(--gray2);padding:4px 14px;margin-top:10px">
        ${finRowSimple('Tổng Hàng A (Doanh thu)', sum.totalA)}
        ${finRowSimple('Tổng Hàng B (Chi phí)', sum.totalB)}
        ${finRowSimple('Hàng C — Lợi nhuận (A-B)', sum.totalC, true)}
        <div style="font-size:12px;color:var(--gray6);padding:6px 0">Tỷ suất lợi nhuận: <b>${sum.totalA ? ((sum.totalC / sum.totalA) * 100).toFixed(2) : '0.00'}%</b></div>
      </div>
      ${rev.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, rev.current_step, preview)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp — bấm Trình duyệt để bắt đầu luồng phê duyệt.</div>`}
    </div>
    ${actionFooterHtml(rev, 'bctc', user, assignments, (user.roles || []).includes('Admin'))}
  `;

  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(rev, lines || [], user, onClose));
  box.querySelector('#btnDelete')?.addEventListener('click', async () => {
    if (!confirm(`Xóa HẲN "${rev.doc_number}"?\n\nKhác với Hủy — xóa xong sẽ MẤT VĨNH VIỄN, không khôi phục lại được. Chỉ dùng khi đây thật sự là bản lưu tạm chưa dùng tới.`)) return;
    loading(true);
    const { error } = await supabase.from('bctc_revisions').delete().eq('id', rev.id);
    if (error) return toast('Lỗi xóa: ' + error.message, 'error');
    toast('Đã xóa', 'success');
    closeModal(modal, onClose);
  });
  box.querySelector('#btnCancel')?.addEventListener('click', async () => {
    if (!confirm(`Hủy hồ sơ "${rev.doc_number}"?\n\nHồ sơ sẽ chuyển sang trạng thái "Đã hủy", ẩn khỏi danh sách chính — dữ liệu vẫn được giữ nguyên, không mất gì cả. Không hoàn tác được qua giao diện.`)) return;
    const reason = prompt('Lý do hủy (không bắt buộc):') || null;
    loading(true);
    const { error } = await supabase.rpc('fn_cancel_document', { p_doc_type: 'bctc', p_doc_id: rev.id, p_reason: reason });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã hủy hồ sơ', 'success');
    closeModal(modal, onClose);
  });
  wireActions(box, 'bctc', id, rev.current_step, assignments, () => closeModal(modal, onClose));
}

// Bảng XEM (trang chi tiết) — dựng CÙNG kiểu Excel với lúc nhập (sticky header,
// gộp chung 1 bảng cuộn riêng), chỉ khác là chữ tĩnh, không có ô nhập.
function readOnlyRowHtml(l, contractsMap, latestPaidByContract, partnersMap) {
  const forecast = lineForecast(l, contractsMap);
  const payment = linePayment(l, latestPaidByContract);
  const contract = l.contract_id ? contractsMap[l.contract_id] : null;
  const partnerName = contract ? partnersMap[contract.partner_id] : l.partners?.name;
  const CELL = 'padding:4px 6px;font-size:11px';
  return `<tr>
    <td style="${CELL}">${l.ten_hang_muc}</td>
    <td style="${CELL};text-align:center">${contract ? '<span style="color:var(--navy)">✓</span>' : '<span style="color:var(--gray4)">—</span>'}</td>
    <td style="${CELL}">${partnerName || '—'}</td>
    <td class="mono" style="${CELL}">${contract ? contract.doc_number : (l.doc_number_manual || '—')}</td>
    <td class="mono" style="${CELL};text-align:right">${fmt(forecast)}</td>
    <td class="mono" style="${CELL};text-align:right">${fmt(payment)}</td>
    <td class="mono" style="${CELL};text-align:right;font-weight:600">${fmt(forecast - payment)}</td>
    <td style="${CELL};color:var(--gray5)">${l.status_note || '—'}</td>
  </tr>`;
}
function readOnlyTableHeadHtml() {
  const th = (label, extra) => `<th style="position:sticky;top:0;background:#fff;z-index:2;border-bottom:2px solid var(--gray3);padding:5px;font-size:10.5px;text-align:left;white-space:nowrap${extra ? ';' + extra : ''}">${label}</th>`;
  return `<tr>${th('Tên hạng mục')}${th('Hợp đồng liên kết')}${th('Đối tác')}${th('Số HĐ')}${th('Dự trù (trước thuế)', 'text-align:right')}${th('Đã TT (trước thuế)', 'text-align:right')}${th('Còn lại', 'text-align:right')}${th('Ghi chú')}</tr>`;
}
function readOnlyReportTableHtml(allLines, contractsMap, latestPaidByContract, partnersMap, totalA, totalB) {
  const aRows = allLines.filter((l) => l.item_code === 'A' || l.item_code.startsWith('A.'));
  const groups = allLines.filter((l) => l.level === 1 && l.item_code.startsWith('B.'));

  let body = `<tr><td colspan="8" style="background:var(--lblue);padding:5px 6px;font-weight:700;font-size:11px;color:#1D4ED8">HÀNG A — DOANH THU <span class="mono" style="float:right">${fmt(totalA)} ₫</span></td></tr>`;
  body += aRows.length ? aRows.map((l) => readOnlyRowHtml(l, contractsMap, latestPaidByContract, partnersMap)).join('') : `<tr><td colspan="8" style="text-align:center;color:var(--gray4);padding:14px">Chưa có dòng nào</td></tr>`;

  body += `<tr><td colspan="8" style="background:#FEF2F2;padding:5px 6px;font-weight:700;font-size:11px;color:var(--red)">HÀNG B — CHI PHÍ <span class="mono" style="float:right">${fmt(totalB)} ₫</span></td></tr>`;
  if (!groups.length) {
    body += `<tr><td colspan="8" style="text-align:center;color:var(--gray4);padding:14px">Chưa có nhóm chi phí nào</td></tr>`;
  } else {
    groups.forEach((g) => {
      const detailRows = allLines.filter((l) => l.parent_code === g.item_code);
      const groupTotal = detailRows.reduce((s, l) => s + lineForecast(l, contractsMap), 0);
      body += `<tr><td colspan="8" style="background:var(--gray1);padding:4px 6px;font-weight:600;font-size:10.5px">${g.item_code} — ${g.ten_hang_muc} <span class="mono" style="float:right">${fmt(groupTotal)} ₫</span></td></tr>`;
      body += detailRows.length ? detailRows.map((l) => readOnlyRowHtml(l, contractsMap, latestPaidByContract, partnersMap)).join('') : `<tr><td colspan="8" style="text-align:center;color:var(--gray4);padding:10px;font-size:11px">Chưa có dòng nào</td></tr>`;
    });
  }

  return `<div style="max-height:58vh;overflow:auto;border:1px solid var(--gray2);border-radius:8px;margin:10px 0">
    <table style="width:100%;border-collapse:collapse"><thead>${readOnlyTableHeadHtml()}</thead><tbody>${body}</tbody></table>
  </div>`;
}
function finRowSimple(label, value, bold) {
  return `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--gray1);${bold ? 'font-weight:700' : ''}">
    <span style="font-size:12.5px;color:${bold ? 'var(--gray8)' : 'var(--gray7)'}">${label}</span>
    <span class="mono" style="font-size:13px;white-space:nowrap;${bold ? 'font-weight:700;color:var(--navy)' : ''}">${fmt(value)} ₫</span>
  </div>`;
}

// Lấy danh sách Hợp đồng GỐC của dự án (KHÔNG gồm PLHĐ — PLHĐ không được chọn link
// trực tiếp làm "Hợp đồng liên kết" nữa, vì bản thân nó cũng chỉ là 1 dòng trong
// bảng contracts). value của mỗi hợp đồng gốc đã CỘNG DỒN thêm tổng giá trị các
// PLHĐ con của nó — đúng công thức A+B (Giá trị dự trù/HĐ/PLHĐ) khớp với cách Bill
// đang tính C=A+B (Giá trị hợp đồng điều chỉnh).
async function fetchAdjustedContracts(projectId) {
  const { data: raw } = await supabase.from('contracts').select('id, doc_number, value, vat_rate, partner_id, parent_contract_id').eq('project_id', projectId).neq('status', 'cancelled');
  const baseContracts = (raw || []).filter((c) => !c.parent_contract_id).map((c) => ({ ...c, value: Number(c.value) }));
  const baseMap = Object.fromEntries(baseContracts.map((c) => [c.id, c]));
  (raw || []).forEach((c) => {
    if (c.parent_contract_id && baseMap[c.parent_contract_id]) {
      baseMap[c.parent_contract_id].value += Number(c.value); // PLHĐ kế thừa đúng vat_rate của hợp đồng gốc nên cộng dồn thẳng, chia VAT 1 lần là đúng
    }
  });
  return baseContracts;
}

// Lấy toàn bộ dữ liệu Hợp đồng của dự án + bill "paid" mới nhất theo từng hợp đồng
// — dùng chung cho cả xem chi tiết lẫn form nhập, tránh query riêng lẻ từng dòng
async function loadFinancialData(projectId, lines) {
  const contracts = await fetchAdjustedContracts(projectId);
  const contractsMap = Object.fromEntries(contracts.map((c) => [c.id, c]));

  const contractIds = [...new Set((lines || []).map((l) => l.contract_id).filter(Boolean))];
  let latestPaidByContract = {};
  if (contractIds.length) {
    const { data: paidBills } = await supabase.from('bills').select('contract_id, period_no, val_d, vat_rate').in('contract_id', contractIds).eq('status', 'paid').order('period_no', { ascending: false });
    (paidBills || []).forEach((b) => {
      if (!latestPaidByContract[b.contract_id]) latestPaidByContract[b.contract_id] = b; // dòng đầu tiên gặp = period_no cao nhất (đã order DESC)
    });
  }
  return { contracts, contractsMap, latestPaidByContract };
}

// ============================================================
// FORM NHẬP DÙNG CHUNG (Tạo mới / Sửa) — quản lý state ở bộ nhớ, chỉ ghi DB lúc Lưu
// ============================================================
function newLine(overrides = {}) {
  return { ten_hang_muc: '', contract_id: null, partner_id: null, doc_number_manual: '', signed_date_manual: '', forecast_value_manual: 0, payment_data_manual: 0, status_note: 'Đang thực hiện', ...overrides };
}

async function openLineEditorModal({ modal, projectId, initialLines, initialTitle, onSave, contracts, partners }) {
  const contractsMap = Object.fromEntries((contracts || []).map((c) => [c.id, c]));
  let contractIds = initialLines.filter((l) => l.contract_id).map((l) => l.contract_id);
  let latestPaidByContract = {};
  if (contractIds.length) {
    const { data: paidBills } = await supabase.from('bills').select('contract_id, period_no, val_d, vat_rate').in('contract_id', contractIds).eq('status', 'paid').order('period_no', { ascending: false });
    (paidBills || []).forEach((b) => { if (!latestPaidByContract[b.contract_id]) latestPaidByContract[b.contract_id] = b; });
  }

  const state = {
    aRows: initialLines.filter((l) => l.item_code === 'A' || l.item_code.startsWith('A.')),
    bGroups: [],
  };
  const groupHeaders = initialLines.filter((l) => l.level === 1 && l.item_code.startsWith('B.'));
  state.bGroups = groupHeaders.map((g) => ({ name: g.ten_hang_muc, rows: initialLines.filter((l) => l.parent_code === g.item_code) }));
  if (!state.bGroups.length) state.bGroups = [{ name: 'Chi phí gián tiếp', rows: [] }];
  if (!state.aRows.length) state.aRows = [newLine({ ten_hang_muc: 'Doanh thu từ CĐT' })];

  const partnersMap = Object.fromEntries((partners || []).map((p) => [p.id, p.name]));
  const esc = (s) => (s || '').replace(/"/g, '&quot;');

  function partnerOptions(selected) {
    return `<option value="">—</option>` + (partners || []).map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${p.name}</option>`).join('');
  }
  function contractOptions(selected) {
    return `<option value="">— Không link, nhập tay —</option>` + (contracts || []).map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.doc_number}</option>`).join('');
  }

  const CELL = 'padding:3px 5px;font-size:11px';
  const INP = 'font-size:11px;padding:3px 5px;min-height:auto';

  // Mỗi dòng = 1 <tr> thật (kiểu Excel) — gọn hơn nhiều so với thẻ card khi báo cáo
  // có 70-100 dòng. Đối tác/Số HĐ có 2 lớp (ô nhập lúc chưa link + chữ tĩnh lúc đã
  // link), ẩn/hiện qua JS khi đổi Hợp đồng liên kết, không phá layout cột.
  function rowEditorHtml(l, path) {
    const linked = !!l.contract_id;
    const forecast = lineForecast(l, contractsMap);
    const payment = linePayment(l, latestPaidByContract);
    const linkedPartnerName = linked ? partnersMap[contractsMap[l.contract_id]?.partner_id] || '—' : '';
    const linkedDocNumber = linked ? contractsMap[l.contract_id]?.doc_number || '' : '';
    return `<tr class="bctc-row" data-path="${path}">
      <td style="${CELL}"><input type="text" class="form-input f-ten" style="${INP};min-width:150px" value="${esc(l.ten_hang_muc)}"></td>
      <td style="${CELL}"><select class="form-input f-contract" style="${INP};min-width:140px">${contractOptions(l.contract_id)}</select></td>
      <td style="${CELL}">
        <select class="form-input f-partner" style="${INP};min-width:110px;display:${linked ? 'none' : 'block'}">${partnerOptions(l.partner_id)}</select>
        <span class="f-linked-partner" style="font-size:11px;color:var(--gray6);display:${linked ? 'inline' : 'none'}">${linkedPartnerName}</span>
      </td>
      <td style="${CELL}">
        <input type="text" class="form-input f-docnum" style="${INP};min-width:100px;display:${linked ? 'none' : 'block'}" value="${esc(l.doc_number_manual)}">
        <span class="f-linked-docnum mono" style="font-size:10.5px;color:var(--gray6);display:${linked ? 'inline' : 'none'}">${linkedDocNumber}</span>
      </td>
      <td style="${CELL}"><input type="text" inputmode="numeric" class="form-input money-input f-forecast" style="${INP};min-width:100px;text-align:right${linked ? ';background:var(--gray1);color:var(--gray6)' : ''}" value="${formatMoneyInput(forecast)}" ${linked ? 'readonly' : ''}></td>
      <td style="${CELL}"><input type="text" inputmode="numeric" class="form-input money-input f-payment" style="${INP};min-width:100px;text-align:right${linked ? ';background:var(--gray1);color:var(--gray6)' : ''}" value="${formatMoneyInput(payment)}" ${linked ? 'readonly' : ''}></td>
      <td class="mono f-remaining" style="${CELL};text-align:right;font-weight:600;white-space:nowrap">${fmt(forecast - payment)}</td>
      <td style="${CELL}"><input type="text" class="form-input f-note" style="${INP};min-width:110px" value="${esc(l.status_note)}"></td>
      <td style="${CELL};text-align:center"><button type="button" class="f-remove-row" title="Xóa dòng" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px">✕</button></td>
    </tr>`;
  }

  function tableHeadHtml() {
    const th = (label, extra) => `<th style="position:sticky;top:0;background:#fff;z-index:2;border-bottom:2px solid var(--gray3);padding:5px;font-size:10.5px;text-align:left;white-space:nowrap${extra ? ';' + extra : ''}">${label}</th>`;
    return `<tr>${th('Tên hạng mục')}${th('Hợp đồng liên kết')}${th('Đối tác')}${th('Số HĐ')}${th('Dự trù (trước thuế)', 'text-align:right')}${th('Đã TT (trước thuế)', 'text-align:right')}${th('Còn lại', 'text-align:right')}${th('Ghi chú')}${th('', 'width:26px')}</tr>`;
  }
  function groupHeaderRowHtml(g, gi, groupTotal) {
    return `<tr class="bctc-group-header" data-group="${gi}"><td colspan="9" style="background:var(--gray1);padding:5px 6px">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="font-size:10.5px;color:var(--gray6);white-space:nowrap">B.${gi + 1}</b>
        <input type="text" class="form-input f-group-name" style="flex:1;font-weight:600;font-size:11px;padding:3px 6px" value="${esc(g.name)}" placeholder="Tên nhóm chi phí, VD: Chi phí gián tiếp">
        <span class="mono" style="font-weight:700;color:var(--navy);white-space:nowrap;font-size:11px">${fmt(groupTotal)} ₫</span>
        <button type="button" class="f-add-row" data-group="${gi}" style="font-size:10.5px;background:none;border:1px solid var(--gray3);border-radius:5px;padding:2px 7px;cursor:pointer;white-space:nowrap">+ Dòng</button>
        ${gi > 0 || true ? `<button type="button" class="f-remove-group" data-group="${gi}" title="Xóa cả nhóm" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px">✕</button>` : ''}
      </div></td></tr>`;
  }

  function renderAll() {
    const totalA = state.aRows.reduce((s, l) => s + lineForecast(l, contractsMap), 0);
    const totalB = state.bGroups.reduce((s, g) => s + g.rows.reduce((s2, l) => s2 + lineForecast(l, contractsMap), 0), 0);

    let bodyHtml = '';
    bodyHtml += `<tr><td colspan="9" style="background:var(--lblue);padding:5px 6px;font-weight:700;font-size:11px;color:#1D4ED8">HÀNG A — DOANH THU <span class="mono" style="float:right">${fmt(totalA)} ₫</span></td></tr>`;
    bodyHtml += state.aRows.map((l, i) => rowEditorHtml(l, `a.${i}`)).join('');
    bodyHtml += `<tr><td colspan="9" style="padding:5px 6px"><button type="button" id="btnAddA" style="font-size:10.5px;background:none;border:1px solid var(--gray3);border-radius:5px;padding:2px 7px;cursor:pointer">+ Thêm dòng Hàng A</button></td></tr>`;

    bodyHtml += `<tr><td colspan="9" style="background:#FEF2F2;padding:5px 6px;font-weight:700;font-size:11px;color:var(--red)">HÀNG B — CHI PHÍ <span class="mono" style="float:right">${fmt(totalB)} ₫</span></td></tr>`;
    state.bGroups.forEach((g, gi) => {
      const groupTotal = g.rows.reduce((s, l) => s + lineForecast(l, contractsMap), 0);
      bodyHtml += groupHeaderRowHtml(g, gi, groupTotal);
      bodyHtml += g.rows.map((l, i) => rowEditorHtml(l, `b.${gi}.${i}`)).join('');
    });
    bodyHtml += `<tr><td colspan="9" style="padding:5px 6px"><button type="button" id="btnAddGroup" style="font-size:10.5px;background:none;border:1px solid var(--gray3);border-radius:5px;padding:2px 7px;cursor:pointer">+ Thêm nhóm chi phí (B.x)</button></td></tr>`;

    modal.querySelector('#editorArea').innerHTML = `
      <div style="max-height:58vh;overflow:auto;border:1px solid var(--gray2);border-radius:8px;margin-bottom:12px">
        <table style="width:100%;border-collapse:collapse"><thead>${tableHeadHtml()}</thead><tbody>${bodyHtml}</tbody></table>
      </div>
      <div class="card" style="background:var(--gray1);border:1px solid var(--gray2);padding:4px 14px">
        ${finRowSimple('Tổng Hàng A', totalA)}
        ${finRowSimple('Tổng Hàng B', totalB)}
        ${finRowSimple('Hàng C — Lợi nhuận (A-B)', totalA - totalB, true)}
      </div>
    `;
    wireMoneyInputs(modal);
    wireRowEvents();
  }

  function readRowFromDom(rowEl, existing) {
    const contract_id = rowEl.querySelector('.f-contract').value || null;
    return {
      ...existing,
      ten_hang_muc: rowEl.querySelector('.f-ten').value.trim(),
      contract_id,
      partner_id: contract_id ? null : (rowEl.querySelector('.f-partner').value || null),
      doc_number_manual: contract_id ? null : rowEl.querySelector('.f-docnum').value.trim(),
      forecast_value_manual: contract_id ? null : parseMoneyInput(rowEl.querySelector('.f-forecast').value),
      payment_data_manual: contract_id ? null : parseMoneyInput(rowEl.querySelector('.f-payment').value),
      status_note: rowEl.querySelector('.f-note').value.trim(),
    };
  }

  // Đồng bộ state từ DOM hiện tại (trước khi thêm/xóa dòng hoặc Lưu) — tránh mất dữ
  // liệu người dùng vừa gõ dở ở các dòng khác. Dùng data-path/data-group trực tiếp
  // (không còn lồng theo cấu trúc DOM cha-con vì giờ mọi dòng nằm chung 1 <table>).
  function syncStateFromDom() {
    modal.querySelectorAll('.bctc-row').forEach((rowEl) => {
      const parts = rowEl.dataset.path.split('.');
      if (parts[0] === 'a') state.aRows[Number(parts[1])] = readRowFromDom(rowEl, state.aRows[Number(parts[1])]);
      else state.bGroups[Number(parts[1])].rows[Number(parts[2])] = readRowFromDom(rowEl, state.bGroups[Number(parts[1])].rows[Number(parts[2])]);
    });
    modal.querySelectorAll('.bctc-group-header').forEach((el) => {
      state.bGroups[Number(el.dataset.group)].name = el.querySelector('.f-group-name').value.trim();
    });
  }

  function wireRowEvents() {
    modal.querySelectorAll('.f-contract').forEach((sel) =>
      sel.addEventListener('change', (e) => {
        const rowEl = e.target.closest('.bctc-row');
        const linked = !!e.target.value;
        rowEl.querySelector('.f-partner').style.display = linked ? 'none' : 'block';
        rowEl.querySelector('.f-linked-partner').style.display = linked ? 'inline' : 'none';
        rowEl.querySelector('.f-docnum').style.display = linked ? 'none' : 'block';
        rowEl.querySelector('.f-linked-docnum').style.display = linked ? 'inline' : 'none';
        const c = linked ? contractsMap[e.target.value] : null;
        if (c) {
          rowEl.querySelector('.f-linked-partner').textContent = partnersMap[c.partner_id] || '—';
          rowEl.querySelector('.f-linked-docnum').textContent = c.doc_number;
          const forecast = lineForecast({ contract_id: e.target.value }, contractsMap);
          const payment = linePayment({ contract_id: e.target.value }, latestPaidByContract);
          const fForecast = rowEl.querySelector('.f-forecast');
          const fPayment = rowEl.querySelector('.f-payment');
          fForecast.value = formatMoneyInput(forecast);
          fForecast.readOnly = true;
          fForecast.style.background = 'var(--gray1)';
          fForecast.style.color = 'var(--gray6)';
          fPayment.value = formatMoneyInput(payment);
          fPayment.readOnly = true;
          fPayment.style.background = 'var(--gray1)';
          fPayment.style.color = 'var(--gray6)';
          rowEl.querySelector('.f-remaining').textContent = fmt(forecast - payment);
        } else {
          const fForecast = rowEl.querySelector('.f-forecast');
          const fPayment = rowEl.querySelector('.f-payment');
          fForecast.readOnly = false;
          fForecast.style.background = '';
          fForecast.style.color = '';
          fPayment.readOnly = false;
          fPayment.style.background = '';
          fPayment.style.color = '';
        }
      }),
    );
    modal.querySelector('#btnAddA')?.addEventListener('click', () => {
      syncStateFromDom();
      state.aRows.push(newLine());
      renderAll();
    });
    modal.querySelector('#btnAddGroup')?.addEventListener('click', () => {
      syncStateFromDom();
      state.bGroups.push({ name: '', rows: [] });
      renderAll();
    });
    modal.querySelectorAll('.f-add-row').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        syncStateFromDom();
        state.bGroups[Number(e.target.dataset.group)].rows.push(newLine());
        renderAll();
      }),
    );
    modal.querySelectorAll('.f-remove-group').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        if (state.bGroups.length <= 1) return toast('Phải giữ lại ít nhất 1 nhóm chi phí', 'error');
        syncStateFromDom();
        state.bGroups.splice(Number(e.target.dataset.group), 1);
        renderAll();
      }),
    );
    modal.querySelectorAll('.f-remove-row').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        syncStateFromDom();
        const parts = e.target.closest('.bctc-row').dataset.path.split('.');
        if (parts[0] === 'a') state.aRows.splice(Number(parts[1]), 1);
        else state.bGroups[Number(parts[1])].rows.splice(Number(parts[2]), 1);
        renderAll();
      }),
    );
  }

  renderAll();

  return {
    getState: () => {
      syncStateFromDom();
      return state;
    },
  };
}

// Ghi toàn bộ state (aRows + bGroups) thành các dòng bctc_lines thật, gán đúng
// item_code/parent_code/level theo đúng cấu trúc cây
async function saveLines(revisionId, state) {
  const rows = [];
  state.aRows.forEach((l, i) => {
    rows.push({ revision_id: revisionId, item_code: `A.${String(i + 1).padStart(2, '0')}`, parent_code: 'A', level: 1, sort_order: i, ...pickLineFields(l) });
  });
  state.bGroups.forEach((g, gi) => {
    const groupCode = `B.${gi + 1}`;
    rows.push({ revision_id: revisionId, item_code: groupCode, parent_code: 'B', level: 1, sort_order: gi, ten_hang_muc: g.name || `Nhóm ${gi + 1}` });
    g.rows.forEach((l, i) => {
      rows.push({ revision_id: revisionId, item_code: `${groupCode}.${String(i + 1).padStart(2, '0')}`, parent_code: groupCode, level: 2, sort_order: i, ...pickLineFields(l) });
    });
  });
  await supabase.from('bctc_lines').delete().eq('revision_id', revisionId);
  if (rows.length) await supabase.from('bctc_lines').insert(rows);
}
function pickLineFields(l) {
  return {
    ten_hang_muc: l.ten_hang_muc || '(chưa đặt tên)',
    contract_id: l.contract_id || null,
    partner_id: l.partner_id || null,
    doc_number_manual: l.doc_number_manual || null,
    signed_date_manual: l.signed_date_manual || null,
    forecast_value_manual: l.contract_id ? null : (l.forecast_value_manual || 0),
    payment_data_manual: l.contract_id ? null : (l.payment_data_manual || 0),
    status_note: l.status_note || null,
  };
}

// ============================================================
// TẠO MỚI — chọn Dự án, chọn Rev để kế thừa (không bắt buộc), rồi vào editor
// ============================================================
async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'bctc');

  modal.innerHTML = `<div class="panel-box" style="max-width:1400px;width:97%">
    <div class="panel-header"><div>Trình Báo cáo tài chính mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Kế thừa từ Rev nào (không bắt buộc)</label>
        <select id="fParentRev" class="form-input"><option value="">— Làm mới hoàn toàn —</option></select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chọn 1 Rev cũ để sao chép toàn bộ dòng làm điểm bắt đầu — vẫn sửa/xóa/thêm được thoải mái sau đó.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Ghi chú (không bắt buộc)</label>
        <input type="text" id="fNote" class="form-input" placeholder="VD: Cập nhật định kỳ tháng 8/2026"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>
      <div id="editorArea"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu tạm</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  const { data: partners } = await supabase.from('partners').select('id, name').order('name');
  let editor = null;

  async function loadForProject(projectId) {
    const contracts = await fetchAdjustedContracts(projectId);
    const { data: existingRevs } = await supabase.from('bctc_revisions').select('id, doc_number, rev_no').eq('project_id', projectId).neq('status', 'cancelled').order('rev_no', { ascending: false });
    modal.querySelector('#fParentRev').innerHTML = `<option value="">— Làm mới hoàn toàn —</option>` + (existingRevs || []).map((r) => `<option value="${r.id}">${r.doc_number}</option>`).join('');
    editor = await openLineEditorModal({ modal, projectId, initialLines: [], contracts, partners: partners || [] });
  }

  async function loadParentLines(parentRevId, projectId) {
    const contracts = await fetchAdjustedContracts(projectId);
    let initialLines = [];
    if (parentRevId) {
      const { data } = await supabase.from('bctc_lines').select('*').eq('revision_id', parentRevId).order('item_code');
      initialLines = data || [];
    }
    editor = await openLineEditorModal({ modal, projectId, initialLines, contracts, partners: partners || [] });
  }

  await loadForProject(modal.querySelector('#fProject').value);
  modal.querySelector('#fProject').addEventListener('change', (e) => loadForProject(e.target.value));
  modal.querySelector('#fParentRev').addEventListener('change', (e) => loadParentLines(e.target.value, modal.querySelector('#fProject').value));

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const parent_revision_id = modal.querySelector('#fParentRev').value || null;
    const note = modal.querySelector('#fNote').value.trim();
    const template_id = modal.querySelector('#fTemplate').value || null;
    if (!project_id) return toast('Chọn Dự án trước khi lưu', 'error');

    loading(true);
    const { data: newRev, error } = await supabase.from('bctc_revisions').insert({ project_id, parent_revision_id, note: note || null, template_id, created_by: user.id, status: 'draft' }).select('id, doc_number').single();
    if (error) return toast('Lỗi tạo BCTC: ' + error.message, 'error');

    const state = editor.getState();
    await saveLines(newRev.id, state);

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'bctc', p_doc_id: newRev.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình BCTC', 'success');
      closeModal(modal, onClose);
    } else {
      toast('Đã lưu nháp', 'success');
      closeModal(modal, onClose);
      openDetail(newRev.id, user, onClose);
    }
  }
  modal.querySelector('#btnSaveDraft').addEventListener('click', () => doSave(false));
  modal.querySelector('#btnSubmitNew').addEventListener('click', () => doSave(true));
}

// ============================================================
// SỬA — chỉ mở được khi Nháp/Bị từ chối (canEditNow ở trang chi tiết đã lọc đúng)
// ============================================================
async function openEditModal(rev, currentLines, user, onClose) {
  const modal = ensureModal();
  const contracts = await fetchAdjustedContracts(rev.project_id);
  const { data: partners } = await supabase.from('partners').select('id, name').order('name');
  const { data: templates } = await supabase.from('document_templates').select('id, name').eq('doc_type', 'bctc');

  modal.innerHTML = `<div class="panel-box" style="max-width:1400px;width:97%">
    <div class="panel-header"><div>Sửa BCTC — ${rev.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Ghi chú (không bắt buộc)</label>
        <input type="text" id="fNote" class="form-input" value="${(rev.note || '').replace(/"/g, '&quot;')}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}" ${t.id === rev.template_id ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>
      <div id="editorArea"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(rev.id, user, onClose));

  const editor = await openLineEditorModal({ modal, projectId: rev.project_id, initialLines: currentLines, contracts: contracts || [], partners: partners || [] });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const note = modal.querySelector('#fNote').value.trim();
    const template_id = modal.querySelector('#fTemplate').value || null;

    loading(true);
    const { error } = await supabase.from('bctc_revisions').update({ note: note || null, template_id }).eq('id', rev.id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    const state = editor.getState();
    await saveLines(rev.id, state);

    toast('Đã lưu thay đổi', 'success');
    openDetail(rev.id, user, onClose);
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
function showModal(modal, onClose, hashOverride) {
  modal.classList.add('show');
  modal.scrollTop = 0;
  pushModalHistory(hashOverride);
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
