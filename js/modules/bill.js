// ============================================================
// bill.js — Module Bill thanh toán theo kỳ
// Công thức: C=A+B | E=-10%×D | G = F==0 ? 0 : -F×(D/(0.8×A)) | H=D+E+F+G | J=H+I
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge, budgetColor, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory, searchSelectHtml, initSearchSelect, setSearchSelectValue, normalizeSearchText, paginationHtml, wirePagination, PAGE_SIZE, IS_MOBILE } from '../core/utils.js';

// Đối tác dùng chung cho ô gõ-tìm ở cả 2 form (Tạo mới / Sửa)
const partnerLabelFn = (p) => p.name;
const partnerSubFn = (p) => `(MST ${p.mst})`;
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, budgetLineRowHtml, wireBudgetLines, readBudgetLines, loadStepPreview } from '../core/approvalUI.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';
let VIEW_PAGE = 1;

export function calcBill(b, contract) {
  const vatRate = (b.vat_rate ?? contract?.vat_rate ?? 8) / 100;
  const C = Number(b.val_a) + Number(b.val_b);
  const VAT = Math.round(Number(b.val_d) - Number(b.val_d) / (1 + vatRate)); // D đã BAO GỒM VAT — tách phần thuế ra bằng D - D/(1+thuế suất), không nhân thẳng D×% (sẽ tính dư)
  const E = Number(b.val_e) || 0; // giữ lại — QS nhập trực tiếp bằng VNĐ (số âm), không còn tính theo %
  const G = Number(b.val_g) || 0; // hoàn trả tạm ứng — QS nhập trực tiếp bằng VNĐ, không tự = -F (hoàn trả có thể chia nhiều kỳ, không nhất thiết trùng đúng F)
  const H = Number(b.val_h) || 0;
  const I = Number(b.val_d) + E + Number(b.val_f) + G + H; // D ở đây đã BAO GỒM VAT (theo đúng mẫu chứng từ thật) — không cộng thêm VAT vào I nữa
  const K = I + Number(b.val_i); // "J" trên chứng từ = val_i trong database (giữ tên cột cũ, chỉ đổi nhãn hiển thị)
  return { C, VAT, E, G, H, I, K };
}

// Khi hợp đồng liên kết có NHIỀU mã ngân sách, tách D thành nhiều ô nhập theo từng mã
// (tổng các ô = D) — khớp đúng cách hợp đồng đã chia từ đầu, không nhập gộp 1 số nữa
function renderDSection(wrapEl, contractLines, prefillLines) {
  const isMulti = contractLines && contractLines.length > 1;
  if (!isMulti) {
    const prefill = prefillLines?.[0]?.value ?? '';
    wrapEl.innerHTML = `<label class="form-label">D — Lũy kế thực hiện kỳ này (bao gồm VAT)</label>
      <input type="text" inputmode="numeric" id="fD" class="form-input money-input" value="${prefill ? formatMoneyInput(prefill) : ''}">`;
    return;
  }
  wrapEl.innerHTML = `<label class="form-label">D — Lũy kế thực hiện theo từng mã ngân sách (bao gồm VAT)</label>
    <div class="card" style="padding:10px 14px">
      ${contractLines
        .map((l) => {
          const prefill = prefillLines?.find((p) => p.budget_code === l.budget_code)?.value ?? '';
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="code-chip" style="width:140px;flex:none">${l.budget_code}</span>
          <input type="text" inputmode="numeric" class="d-per-code form-input money-input" data-code="${l.budget_code}" placeholder="Lũy kế theo mã này" value="${prefill ? formatMoneyInput(prefill) : ''}" style="flex:1">
        </div>`;
        })
        .join('')}
      <div class="d-total" style="font-size:12px;font-weight:600;margin-top:6px;color:var(--navy)"></div>
    </div>`;
  const updateTotal = () => {
    const total = [...wrapEl.querySelectorAll('.d-per-code')].reduce((s, i) => s + parseMoneyInput(i.value), 0);
    wrapEl.querySelector('.d-total').textContent = `Tổng D: ${total.toLocaleString('vi-VN')} ₫`;
  };
  wrapEl.addEventListener('input', (e) => {
    if (e.target.classList.contains('d-per-code')) updateTotal();
  });
  updateTotal();
}

function readDValue(wrapEl) {
  const multiInputs = wrapEl.querySelectorAll('.d-per-code');
  if (multiInputs.length) {
    const perCode = [...multiInputs].map((i) => ({ budget_code: i.dataset.code, value: parseMoneyInput(i.value) })).filter((l) => l.value > 0);
    return { val_d: perCode.reduce((s, l) => s + l.value, 0), perCode };
  }
  const single = wrapEl.querySelector('#fD');
  return { val_d: parseMoneyInput(single?.value), perCode: null };
}

// Nhãn nhóm — dùng lại đúng kiểu chữ hoa/màu xám như ở trang duyệt, để form nhập
// và trang duyệt nhìn thống nhất với nhau
function sectionTitleHtml(text) {
  return `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:16px">${text}</div>`;
}

// Khối "Xem trước công thức" — hiển thị lại các dòng C/VAT/E/G/I/K y hệt cách trình
// bày ở trang duyệt (dùng chung finRow), tự cập nhật mỗi khi người dùng gõ số —
// giúp thấy ngay số tiền cuối cùng trước khi trình, thay vì phải trình xong mới biết.
function renderLivePreview(modal) {
  const box = modal.querySelector('#livePreview');
  if (!box) return;
  const val_a = parseMoneyInput(modal.querySelector('#fA')?.value);
  const val_b = parseMoneyInput(modal.querySelector('#fB')?.value);
  const dWrap = modal.querySelector('#dSectionWrap');
  const { val_d } = dWrap ? readDValue(dWrap) : { val_d: 0 };
  const val_e = parseMoneyInput(modal.querySelector('#fE')?.value);
  const val_f = parseMoneyInput(modal.querySelector('#fF')?.value);
  const val_g = parseMoneyInput(modal.querySelector('#fG')?.value);
  const val_h = parseMoneyInput(modal.querySelector('#fH')?.value);
  const val_i = parseMoneyInput(modal.querySelector('#fI')?.value);
  const vat_rate = Number(modal.querySelector('#fVat')?.value) || 0;
  const r = calcBill({ val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, vat_rate });
  box.innerHTML = `
    ${finRow('Giá trị hợp đồng điều chỉnh (có VAT)', r.C, 'C = A+B', true)}
    ${finRow(`VAT (${vat_rate}%)`, r.VAT, '= D - D/(1+VAT%)')}
    ${finRow('Tổng giá trị tiền giữ lại', r.E, 'E')}
    ${finRow('Hoàn trả tạm ứng đến kỳ này', r.G, 'G')}
    ${finRow('Tổng giá trị thanh toán bao gồm tạm ứng', r.I, 'I = D+E+F+G+H', true)}
    ${finRow('Số tiền phải thanh toán đợt này', r.K, 'K = I+J', true)}`;
}

// Kỳ số khóa theo đúng thứ tự lũy kế, J tự = -D của kỳ liền trước (trừ Kỳ 1 vẫn tự nhập tay)
// Nếu CHƯA có hợp đồng liên kết (đi bill trước, làm hợp đồng bù sau) — vẫn theo dõi được,
// tạm dùng cặp Dự án + Đối tác làm "chuỗi tạm" cho tới khi có hợp đồng thật
// Tìm bill KỲ HỢP LỆ MỚI NHẤT cho đúng hợp đồng (hoặc cặp Dự án+Đối tác nếu đi bill tự
// do) — loại hẳn bill đã "Hủy hồ sơ" ra khỏi việc tính kỳ tiếp theo, coi như nó chưa từng
// tồn tại (số kỳ đó được dùng lại). Dùng chung cho cả gợi ý số kỳ (updateKyAndJ) lẫn
// chặn thật lúc lưu (doSave) — để 2 nơi luôn tính ra cùng 1 kết quả, không lệch nhau.
async function findLatestValidBill(contractId, projectId, partnerId, excludeBillId) {
  let q = supabase.from('bills').select('id, period_no, val_a, val_b, val_d, status').neq('status', 'cancelled').order('period_no', { ascending: false }).limit(5);
  if (contractId) {
    q = q.eq('contract_id', contractId);
  } else if (projectId && partnerId) {
    q = q.is('contract_id', null).eq('project_id', projectId).eq('partner_id', partnerId);
  } else {
    return null;
  }
  const { data } = await q;
  if (!data || !data.length) return null;
  // Đang SỬA đúng bill đang là kỳ mới nhất -> phải loại chính nó ra, không được tự
  // coi mình là "kỳ liền trước" của chính mình (lấy limit 5 thay vì 1 để vẫn tìm được
  // kỳ hợp lệ kế tiếp phía sau khi loại trừ)
  const filtered = excludeBillId ? data.filter((b) => b.id !== excludeBillId) : data;
  return filtered.length ? filtered[0] : null;
}

// Lọc danh sách Hợp đồng liên kết theo đúng Dự án + Đối tác đã chọn — Đối tác là
// "chìa khóa" của hợp đồng, tránh gắn nhầm hợp đồng của dự án/đối tác khác vào bill.
// keepId (nếu có) luôn được giữ trong danh sách dù không khớp lọc — dùng khi render
// LẦN ĐẦU form Sửa, để không âm thầm "mất" liên kết hợp đồng cũ đã lưu từ trước.
// Hợp đồng liên kết giờ BẮT BUỘC (không còn "— Chưa liên kết —") — bill mới tạo hoặc
// bill Nháp/Bị từ chối cũ khi sửa đều phải chọn đúng 1 hợp đồng thật.
function contractOptionsHtml(contracts, projectId, partnerId, keepId) {
  const filtered = (contracts || []).filter((c) => {
    if (keepId && c.id === keepId) return true;
    if (projectId && c.project_id !== projectId) return false;
    if (partnerId && c.partner_id !== partnerId) return false;
    return true;
  });
  const placeholder = keepId ? '' : '<option value="" disabled selected>— Chọn hợp đồng (bắt buộc) —</option>';
  return (
    placeholder +
    filtered.map((c) => `<option value="${c.id}" ${c.id === keepId ? 'selected' : ''} data-partner="${c.partner_id}" data-vat="${c.vat_rate}">${c.doc_number}</option>`).join('')
  );
}

// Gọi mỗi khi đổi Dự án/Đối tác SAU KHI form đã mở — nếu hợp đồng đang chọn không còn
// khớp Dự án/Đối tác mới, tự bỏ chọn (không âm thầm giữ lại lựa chọn sai) và báo cho
// người dùng biết, đồng thời bắn 'change' để các phần phụ thuộc (D theo mã, Kỳ/J...)
// tự cập nhật lại đúng theo trạng thái "chưa liên kết".
function refreshContractSelect(modal, contracts, projectId, partnerId) {
  const sel = modal.querySelector('#fContract');
  const currentId = sel.value;
  const stillMatches = currentId && (contracts || []).some((c) => c.id === currentId && (!projectId || c.project_id === projectId) && (!partnerId || c.partner_id === partnerId));
  sel.innerHTML = contractOptionsHtml(contracts, projectId, partnerId, stillMatches ? currentId : null);
  if (currentId && !stillMatches) {
    toast('Đã bỏ chọn Hợp đồng liên kết vì không còn khớp Dự án/Đối tác vừa đổi', 'info');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

const BILL_STATUS_LABEL = { draft: 'nháp', pending: 'đang duyệt', rejected: 'bị từ chối', paid: 'đã thanh toán xong' };



// Chưa chọn Hợp đồng — vì Hợp đồng giờ BẮT BUỘC, không còn "dò theo Dự án+Đối tác"
// (cơ chế cũ, dễ nhầm với bill cũ không liên quan tới đúng hợp đồng đang link) nữa.
// Chỉ đơn giản mở lại 2 ô cho nhập tay, không tự gợi ý gì cả — chờ tới khi có Hợp đồng
// mới bắt đầu tự động (xem updateKyAndJ).
function resetPeriodJFields(modal) {
  const periodInput = modal.querySelector('#fPeriod');
  const jInput = modal.querySelector('#fI');
  const noteEl = modal.querySelector('#kyNote');
  periodInput.readOnly = false;
  periodInput.style.background = '';
  periodInput.title = '';
  jInput.readOnly = false;
  jInput.style.background = '';
  if (noteEl) noteEl.innerHTML = '';
}

async function updateKyAndJ(modal, contractId, projectId, partnerId, excludeBillId) {
  const periodInput = modal.querySelector('#fPeriod');
  const jInput = modal.querySelector('#fI');
  const noteEl = modal.querySelector('#kyNote');
  const aInput = modal.querySelector('#fA');
  const bInput = modal.querySelector('#fB');

  if (!contractId && !(projectId && partnerId)) {
    periodInput.readOnly = false;
    periodInput.style.background = '';
    jInput.readOnly = false;
    jInput.style.background = '';
    if (noteEl) noteEl.innerHTML = '';
    return;
  }

  const latest = await findLatestValidBill(contractId, projectId, partnerId, excludeBillId);

  if (!latest) {
    // Chưa có bill HỢP LỆ nào (bỏ qua bill đã Hủy) cho đúng hợp đồng/cặp này — có thể
    // đây là bill ĐẦU TIÊN nhập vào hệ thống của 1 hồ sơ đã có sẵn ngoài đời (VD thực tế
    // đang ở Kỳ 4) -> mở cho nhập tay tự do, không ép về Kỳ 1. Bill tiếp theo sau đó sẽ
    // tự động nối tiếp đúng từ số vừa nhập (n+1), như bình thường.
    if (!periodInput.value) periodInput.value = '1';
    periodInput.readOnly = false;
    periodInput.style.background = '';
    periodInput.title = 'Chưa có bill hợp lệ nào trong hệ thống cho đúng hợp đồng này — nhập đúng đợt thực tế (VD nếu đã tới Đợt 4 ngoài đời, nhập 4).';
    if (!jInput.value) jInput.value = '0';
    jInput.readOnly = false;
    jInput.style.background = '';
    if (noteEl)
      noteEl.innerHTML = `<span style="color:var(--amber);font-weight:600">⚠️ Đợt số và J KHÔNG tự điền — đây là bill ĐẦU TIÊN link vào hợp đồng này.</span>
        <div style="color:var(--gray6);font-weight:400;margin-top:4px">
          Nếu đây là bill kế tiếp của 1 hợp đồng vừa mới bắt buộc gắn (deal đã có bill từ trước, chỉ là trước đây chưa gắn hợp đồng), tự nhập tay đúng 2 chỗ:<br>
          • <b>Đợt số</b>: nhập đúng số đợt thực tế ngoài đời (VD đợt trước là Đợt 4 thì đợt này nhập 5)<br>
          • <b>J (Trừ các đợt thanh toán trước)</b>: mở lại bill đợt liền trước (cũ, chưa gắn hợp đồng) trong danh sách, xem đúng số "Giá trị thực hiện lũy kế", nhập vào đây dưới dạng <b>số âm</b><br>
          Từ đợt kế tiếp trở đi, hệ thống tự động lại bình thường.
        </div>`;
    return;
  }

  periodInput.value = latest.period_no + 1;
  periodInput.readOnly = true;
  periodInput.style.background = 'var(--gray1)';

  // A, B kế thừa đúng số kỳ liền trước (QS đã điền thật, không lấy lại theo hợp đồng gốc
  // nữa) — vẫn để sửa được bình thường nếu hợp đồng có điều chỉnh mới trong kỳ này
  if (aInput) aInput.value = formatMoneyInput(latest.val_a);
  if (bInput) bInput.value = formatMoneyInput(latest.val_b);

  const okToProceed = latest.status === 'paid';
  periodInput.title = !okToProceed ? `⚠️ Đợt ${latest.period_no} chưa duyệt xong (đang ${BILL_STATUS_LABEL[latest.status] || latest.status}) — chưa trình/lưu được đợt này cho tới khi đợt ${latest.period_no} thanh toán xong` : '';
  if (noteEl) {
    noteEl.innerHTML = okToProceed
      ? `<span style="color:var(--red)">⚠️ Đợt ${latest.period_no + 1} này được lập dựa trên đợt ${latest.period_no} (đã duyệt xong, lũy kế đợt trước: ${fmt(latest.val_d)} đ).</span>`
      : `<span style="color:var(--red);font-weight:600">⚠️ Đợt ${latest.period_no} chưa duyệt xong (đang ${BILL_STATUS_LABEL[latest.status] || latest.status}) — phải đợi đợt ${latest.period_no} thanh toán xong mới lưu/trình được đợt ${latest.period_no + 1}.</span>`;
  }

  jInput.value = formatMoneyInput(-Number(latest.val_d));
  jInput.readOnly = true;
  jInput.style.background = 'var(--gray1)';
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: bills, error }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    (VIEW_PROJECT !== 'ALL'
      ? supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name), projects(name)').eq('project_id', VIEW_PROJECT)
      : supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name), projects(name)')
    ).neq('status', 'cancelled').order('created_at', { ascending: false }),
  ]);

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  const sorted = [...(bills || [])].sort((a, b) => {
    const ad = a.status === 'closed' ? 1 : 0;
    const bd = b.status === 'closed' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  container.innerHTML = `
    <div style="display:flex;${IS_MOBILE ? 'flex-direction:column;align-items:stretch' : 'justify-content:space-between;flex-wrap:wrap'};margin-bottom:12px;gap:10px">
      <div style="display:flex;gap:8px;${IS_MOBILE ? 'flex-direction:column' : 'flex-wrap:wrap'}">
        <select class="btn btn-secondary" id="projFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">
          <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
          ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
        </select>
        <input type="text" class="form-input" id="partnerFilter" placeholder="🔎 Lọc theo tên Đối tác/NCC..." style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : 'min-width:220px'}">
      </div>
      <button class="btn btn-primary" id="btnNew" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">+ Trình bill thanh toán</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto"><table><thead><tr>${IS_MOBILE ? '<th>Dự án</th><th>Đối tác</th><th>Giá trị thanh toán</th>' : '<th>Dự án</th><th>Đối tác</th><th>Đợt bill</th><th>Giá trị Hợp đồng</th><th>Tổng sản lượng</th><th>Đề nghị đợt này</th><th>Trạng thái</th>'}</tr></thead><tbody id="billTbody"></tbody></table></div>
      <div id="billPagination"></div>
    </div>`;

  let currentList = sorted;

  function draw() {
    const totalPages = Math.max(1, Math.ceil(currentList.length / PAGE_SIZE));
    VIEW_PAGE = Math.min(Math.max(1, VIEW_PAGE), totalPages);
    const pageItems = currentList.slice((VIEW_PAGE - 1) * PAGE_SIZE, VIEW_PAGE * PAGE_SIZE);
    container.querySelector('#billTbody').innerHTML = renderBillRows(pageItems);
    container.querySelector('#billPagination').innerHTML = paginationHtml(VIEW_PAGE, currentList.length);
    wirePagination(container.querySelector('#billPagination'), VIEW_PAGE, currentList.length, (p) => {
      VIEW_PAGE = p;
      draw();
    });
    container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
  }

  container.querySelector('#partnerFilter').addEventListener('input', (e) => {
    const q = normalizeSearchText(e.target.value);
    currentList = q ? sorted.filter((b) => normalizeSearchText(b.partners?.name || '').includes(q)) : sorted;
    VIEW_PAGE = 1;
    draw();
  });

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    VIEW_PAGE = 1;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  draw();
}

function renderBillRows(list) {
  if (!list.length) return `<tr><td colspan="${IS_MOBILE ? 3 : 7}" style="text-align:center;color:var(--gray4);padding:20px">Không có bill nào — kiểm tra lại bộ lọc Dự án/Đối tác nếu đang lọc</td></tr>`;
  return list
    .map((b) => {
      const { C, K } = calcBill(b);
      if (IS_MOBILE) {
        return `<tr class="click" data-id="${b.id}"><td>${b.projects?.name || '—'}</td><td>${b.partners?.name || '—'} <span style="color:var(--gray4);font-size:11px">(Đợt ${b.period_no})</span></td><td class="mono">${fmt(K)}</td></tr>`;
      }
      const pct = C > 0 ? Math.round((Number(b.val_d) / C) * 100) : null;
      return `<tr class="click" data-id="${b.id}"><td>${b.projects?.name || '—'}</td><td>${b.partners?.name || '—'}</td><td>Đợt ${b.period_no}</td>
      <td class="mono">${fmt(C)}</td><td class="mono">${fmt(b.val_d)}</td><td class="mono">${fmt(K)}</td>
      <td><div style="font-weight:700;white-space:nowrap;color:${pct == null ? 'var(--gray4)' : budgetColor(pct)}">${pct == null ? '—' : pct + '%'}</div><div style="margin-top:2px">${statusBadge(b.status)}</div></td></tr>`;
    })
    .join('');
}

function finRow(label, value, code, bold) {
  // Bỏ cột công thức (code) theo yêu cầu — chỉ còn nhãn (được xuống hàng tự do) và số
  // tiền (bắt buộc nằm nguyên 1 hàng, không bao giờ được xuống dòng giữa chừng số).
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid var(--gray1);${bold ? 'font-weight:700;' : ''}">
    <span style="font-size:12.5px;color:${bold ? 'var(--gray8)' : 'var(--gray7)'}">${label}</span>
    <span class="mono" style="font-size:13px;white-space:nowrap;flex-shrink:0;${bold ? 'font-weight:700;color:var(--navy)' : ''}">${value === 0 ? '—' : fmt(value) + ' ₫'}</span>
  </div>`;
}

// Xuất tờ cover để kẹp hồ sơ cứng — giống hệt cách làm ở Hợp đồng/Tờ trình,
// có thêm bảng công thức thanh toán A→K đặc thù của Bill
async function openPrintCoverSheet(b, r, assignments, logs) {
  const { data: files } = await supabase.from('attachments').select('file_name').eq('owner_type', 'bill').eq('owner_id', b.id);

  const submitLog = logs.find((l) => l.action === 'submit');
  const commentLogs = logs.filter((l) => l.comment);
  const vnDate = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');
  const vnMoney = (v) => `${fmt(v)} ₫`;

  const workflowRows = assignments
    .map((a) => ({
      step: a.step_no,
      name: a.users?.full_name || '—',
      jobTitle: a.users?.job_title || '',
      status: a.status === 'approved' ? 'Duyệt' : a.status === 'rejected' ? 'Từ chối' : 'Đang chờ',
      doneDate: vnDate(a.acted_at),
    }))
    .sort((x, y) => x.step - y.step);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${b.doc_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12.5px;padding:24px;color:#111}
      table{width:100%;border-collapse:collapse;margin-bottom:10px}
      td,th{border:1px solid #333;padding:6px 9px;text-align:left;vertical-align:top}
      th{background:#f0ece3}
      .title{font-size:16px;font-weight:700;text-align:center;padding:10px}
      .label{font-weight:600;width:190px;background:#f7f5f0}
      .num{text-align:right;font-family:monospace}
      .no-print{margin-bottom:14px}
      .logo{height:42px;margin-bottom:12px;display:block}
      @media print{.no-print{display:none}}
    </style></head>
    <body>
      <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-size:13px">🖨️ In / Lưu thành PDF</button></div>
      <img class="logo" src="https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png" alt="VELA">
      <table>
        <tr><td colspan="2" class="title">WORKFLOW BILL THANH TOÁN</td></tr>
        <tr><td class="label">Số bill</td><td>${b.doc_number} — Đợt ${b.period_no}</td></tr>
        <tr><td class="label">Ngày lập</td><td>${vnDate(b.signed_date)}</td></tr>
        <tr><td class="label">Quy trình duyệt</td><td>${b.document_templates?.name || '—'}</td></tr>
        <tr><td class="label">Đối tác</td><td>${b.partners?.name || '—'}</td></tr>
        <tr><td class="label">Gói thầu / Nội dung</td><td>${b.projects?.name || '—'}</td></tr>
        <tr><td class="label">Hợp đồng liên kết</td><td>${b.contracts?.doc_number || '—'}</td></tr>
        <tr><td class="label">Ngày gửi</td><td>${submitLog ? vnDate(submitLog.created_at) : '—'}</td></tr>
        <tr><td class="label">Người lập / Người gửi duyệt</td><td>${b.users?.full_name || '—'}</td></tr>
      </table>

      <table>
        <tr><th colspan="2">Công thức thanh toán</th></tr>
        <tr><td class="label">A — Giá trị HĐ ban đầu (có VAT)</td><td class="num">${vnMoney(b.val_a)}</td></tr>
        <tr><td class="label">B — Điều chỉnh hợp đồng (có VAT)</td><td class="num">${vnMoney(b.val_b)}</td></tr>
        <tr><td class="label">C — Giá trị HĐ điều chỉnh (=A+B)</td><td class="num">${vnMoney(r.C)}</td></tr>
        <tr><td class="label">D — Thực hiện lũy kế (bao gồm VAT)</td><td class="num">${vnMoney(b.val_d)}</td></tr>
        <tr><td class="label">VAT (${b.vat_rate}%)</td><td class="num">${vnMoney(r.VAT)}</td></tr>
        <tr><td class="label">E — Giữ lại kỳ này</td><td class="num">${vnMoney(r.E)}</td></tr>
        <tr><td class="label">F — Giá trị tạm ứng</td><td class="num">${vnMoney(b.val_f)}</td></tr>
        <tr><td class="label">G — Hoàn trả tạm ứng đến kỳ này</td><td class="num">${vnMoney(r.G)}</td></tr>
        <tr><td class="label">H — Giá trị khấu trừ${b.val_h ? ' (' + (b.deduction_note || 'chưa ghi lý do') + ')' : ''}</td><td class="num">${vnMoney(r.H)}</td></tr>
        <tr><td class="label">I — Tổng thanh toán bao gồm tạm ứng (=D+E+F+G+H)</td><td class="num">${vnMoney(r.I)}</td></tr>
        <tr><td class="label">J — Trừ các đợt thanh toán trước</td><td class="num">${vnMoney(b.val_i)}</td></tr>
        <tr><td class="label" style="font-weight:700">K — Số tiền phải thanh toán đợt này (=I+J)</td><td class="num" style="font-weight:700">${vnMoney(r.K)}</td></tr>
      </table>

      <table><tr><th colspan="2">Tài liệu đính kèm</th></tr>
        ${(files || []).length ? files.map((f, i) => `<tr><td style="width:40px">${i + 1}</td><td>${f.file_name}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có file đính kèm</td></tr>'}
      </table>

      <table><tr><th colspan="2">Ý kiến</th></tr>
        ${commentLogs.length ? commentLogs.map((l) => `<tr><td style="width:170px;font-weight:600">${l.users?.full_name || '—'}</td><td>${l.comment}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có ý kiến bổ sung</td></tr>'}
      </table>

      <table>
        <tr><th>Thứ tự duyệt</th><th>Người thực hiện</th><th>Chức danh</th><th>Trạng thái</th><th>Ngày hoàn thành</th></tr>
        ${workflowRows.map((r2) => `<tr><td>${r2.step}</td><td>${r2.name}</td><td>${r2.jobTitle}</td><td>${r2.status}</td><td>${r2.doneDate}</td></tr>`).join('')}
        <tr><td colspan="4" style="text-align:right;font-weight:700">Hoàn thành duyệt</td><td>${vnDate(b.completed_at)}</td></tr>
      </table>
    </body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    toast('Trình duyệt đang chặn cửa sổ bật lên — cho phép popup rồi thử lại.', 'error');
    return;
  }
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose, `bill/${id}`);

  const { data: b } = await supabase
    .from('bills')
    .select('*, partners(name), projects(name), contracts(doc_number, value, retention_rate, vat_rate), bill_budget_lines(budget_code, value), document_templates(name), users!created_by(full_name)')
    .eq('id', id)
    .single();
  if (!b) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ.</div>`;
    return;
  }
  const r = calcBill(b, b.contracts);
  const { assignments, logs } = await loadApprovalState('bill', id);
  const preview = b.status === 'pending' ? await loadStepPreview(b.project_id, b.template_id, b.current_step) : {};
  const req = b.checklist_required || 0;
  const { count: attachCount } = await supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('owner_type', 'bill').eq('owner_id', id);
  const done = attachCount || 0;

  // "Dự trù tài chính (chưa thuế)" = chính là Ngân sách phân bổ (phiên bản hiện hành)
  // theo đúng mã ngân sách của bill này — tính động, không nhập tay
  let budgetForecast = null;
  const billBudgetCode = b.bill_budget_lines?.[0]?.budget_code;
  if (billBudgetCode) {
    const { data: latestRev } = await supabase.from('budget_revisions').select('id, revision_code').eq('project_id', b.project_id).order('effective_date', { ascending: false }).limit(1).maybeSingle();
    if (latestRev) {
      const { data: line } = await supabase.from('budget_revision_lines').select('allocated_value').eq('revision_id', latestRev.id).eq('budget_code', billBudgetCode).maybeSingle();
      if (line) budgetForecast = { value: line.allocated_value, revision: latestRev.revision_code };
    }
  }

  const canEditNow = b.created_by === user.id && ['draft', 'rejected'].includes(b.status);
  const isAdmin = (user.roles || []).includes('Admin');
  const canCancel = isAdmin && ['draft', 'rejected'].includes(b.status);
  const isKscp = (user.roles || []).some((r) => ['Admin', 'QLCPHD_CV', 'QLCPHD_TP'].includes(r));
  const canExportPdf = b.current_step >= 3 || b.status === 'active';
  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${b.projects?.name || '—'}</div><div class="meta">${b.partners?.name || '—'}</div><div class="meta">Đợt ${b.period_no}</div><div class="meta mono">${b.doc_number}</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        ${isKscp ? `<button class="btn btn-sm btn-secondary" id="btnEditBudgetLines">🧮 Sửa mã ngân sách</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm btn-danger" id="btnCancel">🗑️ Hủy hồ sơ</button>` : ''}
        ${canExportPdf ? `<button class="btn btn-sm btn-secondary" id="btnExportPdf">🖨️ Xuất PDF (tờ cover)</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      ${b.contract_ceiling_flag ? `<div class="warn-box">⚠️ <div><b>Case 1 — Lũy kế thực hiện đã vượt giá trị hợp đồng.</b> Vẫn duyệt bình thường; cần bổ sung phụ lục hợp đồng để hợp thức hóa.</div></div>` : ''}
      <div class="kv">
        <div class="k">Gói thầu</div><div class="v" style="font-weight:600">${b.scope || '—'}</div>
        <div class="k">Ngày ký hồ sơ</div><div class="v">${b.signed_date ? new Date(b.signed_date).toLocaleDateString('vi-VN') : '<span style="color:var(--gray4)">Chưa ghi</span>'}</div>
        ${b.completed_at ? `<div class="k">Ngày hoàn thành</div><div class="v">${new Date(b.completed_at).toLocaleDateString('vi-VN')}</div>` : ''}
        <div class="k">Trạng thái</div><div class="v">${statusBadge(b.status)}</div>
        <div class="k">Hợp đồng liên kết</div><div class="v">${b.contracts ? `<span class="code-chip">${b.contracts.doc_number}</span>` : '<span style="color:var(--amber)">⚠️ Chưa gắn hợp đồng</span>'}</div>
        <div class="k">Chia mã ngân sách</div><div class="v">${(b.bill_budget_lines || []).map((l) => `<div class="budget-line"><span class="code-chip">${l.budget_code}</span><span class="mono">${fmt(l.value)} ₫</span></div>`).join('') || '—'}</div>
      </div>
      <div class="card" style="background:var(--gray1);border:1px solid var(--gray2)">
        ${finRow(`Dự trù tài chính (chưa thuế)${budgetForecast ? ' — theo ngân sách ' + budgetForecast.revision : ''}`, budgetForecast?.value ?? 0, '')}
        ${!budgetForecast ? `<div style="font-size:11px;color:var(--gray4);margin-top:4px">Chưa chia mã ngân sách, hoặc dự án chưa có phiên bản ngân sách — không lấy được số này.</div>` : ''}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chi tiết hợp đồng</div>
      <div class="card" style="padding:4px 14px">
        ${finRow('Giá trị hợp đồng ban đầu (có VAT)', b.val_a, 'A')}
        ${finRow('Điều chỉnh hợp đồng (có VAT)', b.val_b, 'B')}
        ${finRow('Giá trị hợp đồng điều chỉnh (có VAT)', r.C, 'C = A+B', true)}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chi tiết thanh toán</div>
      <div class="card" style="padding:4px 14px">
        ${finRow('Giá trị thực hiện lũy kế đến kỳ này (bao gồm VAT)', b.val_d, 'D')}
        ${finRow(`VAT (${b.vat_rate}%)`, r.VAT, '= D - D/(1+VAT%)')}
        ${finRow('Tổng giá trị tiền giữ lại', r.E, 'E')}
        ${finRow('Giá trị tạm ứng', b.val_f, 'F')}
        ${finRow('Hoàn trả tạm ứng đến kỳ này', r.G, 'G')}
        ${finRow('Giá trị khấu trừ', r.H, 'H', false)}
        ${b.val_h ? `<div style="font-size:11.5px;color:var(--gray5);margin:-4px 0 6px;padding-left:2px">Lý do: ${b.deduction_note || '(chưa ghi lý do)'}</div>` : ''}
        ${finRow('Tổng giá trị thanh toán bao gồm tạm ứng', r.I, 'I = D+E+F+G+H', true)}
        ${finRow('Trừ các đợt thanh toán trước', b.val_i, 'J')}
        ${finRow('Số tiền phải thanh toán đợt này', r.K, 'K = I+J', true)}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hồ sơ đính kèm</div>
      <div class="card" id="attachArea"></div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Checklist hồ sơ đính kèm</div>
      <div class="card"><div style="font-size:13px">${req ? `${done}/${req} hồ sơ bắt buộc đã có (tự đếm theo số file đính kèm ở trên)` : 'Chưa thiết lập checklist cho bill này'}</div>
      <div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${req ? (done / req * 100) : 0}%;background:${done >= req && req ? 'var(--green)' : 'var(--amber)'}"></div></div></div>
      ${b.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, b.current_step, preview)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp.</div>`}
    </div>
    ${actionFooterHtml(b, 'bill', user, assignments, (user.roles || []).includes('Admin'))}
  `;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(b, user, onClose));
  box.querySelector('#btnEditBudgetLines')?.addEventListener('click', () => openBudgetLinesEditor(b, user, onClose));
  box.querySelector('#btnCancel')?.addEventListener('click', async () => {
    if (!confirm(`Hủy hồ sơ "${b.doc_number}"?\n\nHồ sơ sẽ chuyển sang trạng thái "Đã hủy", ẩn khỏi danh sách chính — dữ liệu vẫn được giữ nguyên, không mất gì cả. Không hoàn tác được qua giao diện.`)) return;
    const reason = prompt('Lý do hủy (không bắt buộc):') || null;
    loading(true);
    const { error } = await supabase.rpc('fn_cancel_document', { p_doc_type: 'bill', p_doc_id: b.id, p_reason: reason });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã hủy hồ sơ', 'success');
    closeModal(modal, onClose);
  });
  box.querySelector('#btnExportPdf')?.addEventListener('click', () => openPrintCoverSheet(b, r, assignments, logs));
  const canEditAttach = b.created_by === user.id && ['draft', 'rejected'].includes(b.status);
  renderAttachments(box.querySelector('#attachArea'), 'bill', id, user.id, canEditAttach);
  wireActions(box, 'bill', id, b.current_step, assignments, () => closeModal(modal, onClose));
}

async function openBudgetLinesEditor(bill, user, onClose) {
  const modal = ensureModal();
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: currentLines } = await supabase.from('bill_budget_lines').select('budget_code, value').eq('bill_id', bill.id);

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa mã ngân sách — ${bill.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Chỉ sửa cách chia mã ngân sách để phục vụ đối chiếu báo cáo tài chính — không đụng tới số liệu D/E/F/G/H hay luồng duyệt. Tổng các dòng nên khớp với D đã trình, nhưng không bị chặn nếu lệch.</div>
      <div class="card" id="budgetLinesWrap" style="padding:12px 14px">
        <div class="bl-rows">${(currentLines && currentLines.length ? currentLines : [{}]).map((l) => budgetLineRowHtml(categories || [], l.budget_code, l.value)).join('')}</div>
        <button type="button" class="btn btn-sm btn-secondary bl-add">+ Thêm dòng</button>
        <div class="bl-total" style="font-size:12px;margin-top:8px;font-weight:600"></div>
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu điều chỉnh</button></div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(bill.id, user, onClose));
  wireBudgetLines(modal.querySelector('#budgetLinesWrap'), categories || [], '#__no_target__');

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const lines = readBudgetLines(modal.querySelector('#budgetLinesWrap'));
    if (!lines.length) return toast('Chọn ít nhất 1 mã ngân sách có giá trị', 'error');

    loading(true);
    await supabase.from('bill_budget_lines').delete().eq('bill_id', bill.id);
    const { error } = await supabase.from('bill_budget_lines').insert(lines.map((l) => ({ bill_id: bill.id, budget_code: l.budget_code, value: l.value })));
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    await supabase.from('approval_logs').insert({ document_type: 'bill', document_id: bill.id, user_id: user.id, action: 'edit_budget', comment: 'QLCP&HĐ điều chỉnh chia mã ngân sách' });

    toast('Đã lưu điều chỉnh mã ngân sách', 'success');
    openDetail(bill.id, user, onClose);
  });
}

async function openEditModal(bill, user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst').order('name');
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, value_adjustment, project_id, partner_id, vat_rate').neq('status', 'cancelled').order('doc_number');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: currentLines } = await supabase.from('bill_budget_lines').select('budget_code, value').eq('bill_id', bill.id);
  const currentBudgetCode = currentLines?.[0]?.budget_code || '';

  // Nếu hợp đồng liên kết có nhiều mã, cần biết trước để vẽ đúng dSection nhiều dòng ngay từ đầu
  let contractLinesForBill = null;
  if (bill.contract_id) {
    const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', bill.contract_id);
    if (cLines && cLines.length > 1) contractLinesForBill = cLines;
  }

  modal.innerHTML = `<div class="panel-box" style="max-width:760px;width:95%">
    <div class="panel-header"><div>Sửa bill — ${bill.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}" ${p.id === bill.project_id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Hợp đồng liên kết (không bắt buộc)</label>
        <select id="fContract" class="form-input">${contractOptionsHtml(contracts, bill.project_id, bill.partner_id, bill.contract_id)}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC) *</label>
        ${searchSelectHtml('fPartner', partners, bill.partner_id, { placeholder: 'Gõ tên hoặc MST để tìm...', labelFn: partnerLabelFn, subFn: partnerSubFn })}</div>
      <div style="margin-bottom:13px"><label class="form-label">Đợt số</label>
        <input type="number" id="fPeriod" class="form-input" value="${bill.period_no}" min="1">
        <div id="kyNote" style="font-size:11.5px;margin-top:4px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Gói thầu / nội dung kỳ này</label>
        <input type="text" id="fScope" class="form-input" value="${bill.scope || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input" value="${bill.signed_date || ''}"></div>

      ${sectionTitleHtml('Chi tiết hợp đồng')}
      <div class="card" style="padding:14px;margin-top:8px;margin-bottom:6px">
        <div style="margin-bottom:13px"><label class="form-label">A — Giá trị hợp đồng ban đầu (có VAT)</label><input type="text" inputmode="numeric" id="fA" class="form-input money-input" value="${formatMoneyInput(bill.val_a)}"></div>
        <div><label class="form-label">B — Điều chỉnh hợp đồng (có VAT)</label><input type="text" inputmode="numeric" id="fB" class="form-input money-input" value="${formatMoneyInput(bill.val_b)}"></div>
      </div>

      ${sectionTitleHtml('Chi tiết thanh toán')}
      <div class="card" style="padding:14px;margin-top:8px;margin-bottom:6px">
        <div id="dSectionWrap" style="margin-bottom:13px"></div>
        <div style="margin-bottom:13px"><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="${bill.vat_rate}" step="0.1"></div>
        <div style="margin-bottom:13px"><label class="form-label">E — Giá trị giữ lại kỳ này (VNĐ)</label><input type="text" inputmode="numeric" id="fE" class="form-input money-input" value="${formatMoneyInput(bill.val_e || 0)}">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Nhập số âm (VD: -178.953.245) vì đây là khoản làm giảm số tiền thanh toán — QS nhập trực tiếp theo đúng kỳ này, không tự tính theo %.</div></div>
        <div style="margin-bottom:13px"><label class="form-label">F — Giá trị tạm ứng</label><input type="text" inputmode="numeric" id="fF" class="form-input money-input" value="${formatMoneyInput(bill.val_f)}"></div>
        <div style="margin-bottom:13px"><label class="form-label">G — Hoàn trả tạm ứng đến kỳ này (VNĐ)</label><input type="text" inputmode="numeric" id="fG" class="form-input money-input" value="${formatMoneyInput(bill.val_g || 0)}">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Nhập số âm — QS nhập trực tiếp theo đúng kỳ này, không tự bằng -F (tạm ứng có thể hoàn trả nhiều kỳ, không nhất thiết trùng đúng F).</div></div>
        <div style="margin-bottom:13px" id="deductNoteWrap">
          <label class="form-label">H — Giá trị khấu trừ</label><input type="text" inputmode="numeric" id="fH" class="form-input money-input" value="${formatMoneyInput(bill.val_h || 0)}">
          <div style="margin-top:8px"><label class="form-label">Lý do khấu trừ (bắt buộc nếu H khác 0)</label><input type="text" id="fDeductNote" class="form-input" value="${bill.deduction_note || ''}"></div>
        </div>
        <div><label class="form-label">J — Trừ các đợt thanh toán trước (số âm)</label><input type="text" inputmode="numeric" id="fI" class="form-input money-input" value="${formatMoneyInput(bill.val_i)}">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Đợt 1: tự nhập tay. Từ đợt 2: tự khóa, lấy đúng -D của đợt liền trước.</div></div>
      </div>

      ${sectionTitleHtml('Xem trước công thức')}
      <div class="card" id="livePreview" style="padding:4px 14px;margin-top:8px;margin-bottom:13px"></div>

      <div id="singleBudgetCodeWrap"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}" ${c.code === currentBudgetCode ? 'selected' : ''}>${c.code} — ${c.name}</option>`).join('')}</select></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(bill.id, user, onClose));
  initSearchSelect(modal, 'fPartner', partners, { labelFn: partnerLabelFn, subFn: partnerSubFn });
  modal.addEventListener('input', () => renderLivePreview(modal));

  const dWrap = modal.querySelector('#dSectionWrap');
  renderDSection(dWrap, contractLinesForBill, currentLines);
  modal.querySelector('#singleBudgetCodeWrap').style.display = contractLinesForBill ? 'none' : '';
  renderLivePreview(modal);

  modal.querySelector('#fContract').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.value) {
      // A, B KHÔNG còn tự lấy theo giá trị hợp đồng gốc nữa — updateKyAndJ() bên dưới sẽ
      // tự kế thừa đúng số QS đã điền ở kỳ liền trước (nếu có); nếu là kỳ đầu tiên thì để
      // trống, QS tự nhập theo đúng số thực tế của bill này.
      if (opt.dataset.partner) setSearchSelectValue(modal, 'fPartner', partners, opt.dataset.partner, partnerLabelFn, partnerSubFn);
      if (opt.dataset.vat) modal.querySelector('#fVat').value = opt.dataset.vat;

      const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', opt.value);
      renderDSection(dWrap, cLines, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = cLines && cLines.length > 1 ? 'none' : '';
      await updateKyAndJ(modal, opt.value, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value, bill.id);
    } else {
      renderDSection(dWrap, null, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = '';
      resetPeriodJFields(modal);
    }
    renderLivePreview(modal);
  });

  // Hợp đồng giờ BẮT BUỘC — đổi Dự án/Đối tác chỉ để lọc lại danh sách Hợp đồng cho khớp,
  // KHÔNG còn tự gợi ý Đợt/J theo Dự án+Đối tác nữa (dễ nhầm với bill cũ không liên quan)
  modal.querySelector('#fProject').addEventListener('change', () => {
    refreshContractSelect(modal, contracts, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
  });
  modal.querySelector('#fPartner').addEventListener('change', () => {
    refreshContractSelect(modal, contracts, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const contract_id = modal.querySelector('#fContract').value || null;
    const partner_id = modal.querySelector('#fPartner').value;
    const period_no = Number(modal.querySelector('#fPeriod').value);
    const scope = modal.querySelector('#fScope').value;
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const val_a = parseMoneyInput(modal.querySelector('#fA').value);
    const val_b = parseMoneyInput(modal.querySelector('#fB').value);
    const { val_d, perCode } = readDValue(dWrap);
    const val_e = parseMoneyInput(modal.querySelector('#fE').value);
    const val_f = parseMoneyInput(modal.querySelector('#fF').value);
    const val_g = parseMoneyInput(modal.querySelector('#fG').value);
    const val_i = parseMoneyInput(modal.querySelector('#fI').value);
    const val_h = parseMoneyInput(modal.querySelector('#fH').value);
    const deduction_note = modal.querySelector('#fDeductNote').value.trim();
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;

    if (!project_id || !partner_id || !contract_id || !val_a || (!perCode && !budget_code)) return toast('Điền đủ thông tin bắt buộc (kể cả Đối tác + Hợp đồng liên kết)', 'error');
    if (val_h !== 0 && !deduction_note) return toast('Có giá trị khấu trừ thì phải ghi rõ lý do', 'error');

    loading(true);
    const { error } = await supabase
      .from('bills')
      .update({ project_id, contract_id, partner_id, period_no, scope, signed_date, val_a, val_b, val_d, val_e, val_f, val_g, val_i, val_h, deduction_note: deduction_note || null, vat_rate })
      .eq('id', bill.id);
    if (error) {
      if (error.message.includes('bills_require_contract_when_editable')) return toast('Bill Nháp/Bị từ chối bắt buộc phải chọn Hợp đồng liên kết trước khi lưu.', 'error');
      if (error.message.includes('bills_doc_number_unique')) return toast('Số bill này đã tồn tại — thử lại (có thể trùng do 2 người thao tác cùng lúc).', 'error');
      return toast('Lỗi lưu: ' + error.message, 'error');
    }

    const linesToSave = perCode && perCode.length ? perCode : [{ budget_code, value: val_d }];
    await supabase.from('bill_budget_lines').delete().eq('bill_id', bill.id);
    await supabase.from('bill_budget_lines').insert(linesToSave.map((l) => ({ bill_id: bill.id, budget_code: l.budget_code, value: l.value })));

    toast('Đã lưu thay đổi', 'success');
    openDetail(bill.id, user, onClose);
  });
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst').order('name');
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, value_adjustment, project_id, partner_id, vat_rate').neq('status', 'cancelled').order('doc_number');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'bill');

  modal.innerHTML = `<div class="panel-box" style="max-width:760px;width:95%">
    <div class="panel-header"><div>Trình bill thanh toán mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Hợp đồng liên kết (không bắt buộc)</label>
        <select id="fContract" class="form-input">${contractOptionsHtml(contracts, projects?.[0]?.id, null, null)}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chọn hợp đồng sẽ tự điền A, B, Đối tác, % VAT theo đúng hợp đồng đó.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC) *</label>
        ${searchSelectHtml('fPartner', partners, null, { placeholder: 'Gõ tên hoặc MST để tìm...', labelFn: partnerLabelFn, subFn: partnerSubFn })}</div>
      <div style="margin-bottom:13px"><label class="form-label">Đợt số</label>
        <input type="number" id="fPeriod" class="form-input" value="1" min="1">
        <div id="kyNote" style="font-size:11.5px;margin-top:4px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Gói thầu / nội dung kỳ này</label>
        <input type="text" id="fScope" class="form-input" placeholder="VD: Cung cấp bê tông tươi mác 300"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input"></div>

      ${sectionTitleHtml('Chi tiết hợp đồng')}
      <div class="card" style="padding:14px;margin-top:8px;margin-bottom:6px">
        <div style="margin-bottom:13px"><label class="form-label">A — Giá trị hợp đồng ban đầu (có VAT)</label><input type="text" inputmode="numeric" id="fA" class="form-input money-input"></div>
        <div><label class="form-label">B — Điều chỉnh hợp đồng (có VAT)</label><input type="text" inputmode="numeric" id="fB" class="form-input money-input" value="0"></div>
      </div>

      ${sectionTitleHtml('Chi tiết thanh toán')}
      <div class="card" style="padding:14px;margin-top:8px;margin-bottom:6px">
        <div id="dSectionWrap" style="margin-bottom:13px"></div>
        <div style="margin-bottom:13px"><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="8" step="0.1"></div>
        <div style="margin-bottom:13px"><label class="form-label">E — Giá trị giữ lại kỳ này (VNĐ)</label><input type="text" inputmode="numeric" id="fE" class="form-input money-input" value="0">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Nhập số âm (VD: -178.953.245) vì đây là khoản làm giảm số tiền thanh toán — QS nhập trực tiếp theo đúng kỳ này, không tự tính theo %.</div></div>
        <div style="margin-bottom:13px"><label class="form-label">F — Giá trị tạm ứng</label><input type="text" inputmode="numeric" id="fF" class="form-input money-input" value="0"></div>
        <div style="margin-bottom:13px"><label class="form-label">G — Hoàn trả tạm ứng đến kỳ này (VNĐ)</label><input type="text" inputmode="numeric" id="fG" class="form-input money-input" value="0">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Nhập số âm — QS nhập trực tiếp theo đúng kỳ này, không tự bằng -F (tạm ứng có thể hoàn trả nhiều kỳ, không nhất thiết trùng đúng F).</div></div>
        <div style="margin-bottom:13px" id="deductNoteWrap">
          <label class="form-label">H — Giá trị khấu trừ</label><input type="text" inputmode="numeric" id="fH" class="form-input money-input" value="0">
          <div style="margin-top:8px"><label class="form-label">Lý do khấu trừ (bắt buộc nếu H khác 0)</label><input type="text" id="fDeductNote" class="form-input" placeholder="VD: Phạt chậm tiến độ 5 ngày"></div>
        </div>
        <div><label class="form-label">J — Trừ các đợt thanh toán trước (số âm)</label><input type="text" inputmode="numeric" id="fI" class="form-input money-input" value="0">
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Đợt 1: tự nhập tay. Từ đợt 2: tự khóa, lấy đúng -D của đợt liền trước.</div></div>
      </div>

      ${sectionTitleHtml('Xem trước công thức')}
      <div class="card" id="livePreview" style="padding:4px 14px;margin-top:8px;margin-bottom:13px"></div>

      <div id="singleBudgetCodeWrap" style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">"Dự trù tài chính" sẽ tự lấy theo đúng Ngân sách phân bổ của mã này, không cần nhập tay.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">${templates.length <= 1 ? 'Tự nhận diện đúng mẫu theo phòng ban/vai trò của bạn.' : 'Đã lọc sẵn các mẫu phù hợp với bạn.'}</div></div>
      <label class="form-label">Hồ sơ đính kèm</label>
      <div class="card" id="filePickerWrap" style="padding:12px 14px;margin-bottom:13px"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu nháp</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  initSearchSelect(modal, 'fPartner', partners, { labelFn: partnerLabelFn, subFn: partnerSubFn });
  modal.addEventListener('input', () => renderLivePreview(modal));

  const filePicker = renderFilePicker(modal.querySelector('#filePickerWrap'));
  const dWrap = modal.querySelector('#dSectionWrap');
  renderDSection(dWrap, null, null); // mặc định: chưa chọn hợp đồng -> D đơn giản
  renderLivePreview(modal);

  // Khi chọn hợp đồng liên kết, tự điền Đối tác + % VAT, và tách D theo mã nếu hợp đồng có nhiều mã.
  // A/B KHÔNG tự lấy theo giá trị hợp đồng gốc nữa — updateKyAndJ() bên dưới sẽ tự kế thừa
  // đúng số QS đã điền ở kỳ liền trước (nếu có); nếu là kỳ đầu tiên thì để trống, QS tự nhập.
  modal.querySelector('#fContract').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.value) {
      if (opt.dataset.partner) setSearchSelectValue(modal, 'fPartner', partners, opt.dataset.partner, partnerLabelFn, partnerSubFn);
      if (opt.dataset.vat) modal.querySelector('#fVat').value = opt.dataset.vat;

      const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', opt.value);
      renderDSection(dWrap, cLines, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = cLines && cLines.length > 1 ? 'none' : '';
      await updateKyAndJ(modal, opt.value, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    } else {
      renderDSection(dWrap, null, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = '';
      resetPeriodJFields(modal);
    }
    renderLivePreview(modal);
  });

  // Hợp đồng giờ BẮT BUỘC — đổi Dự án/Đối tác chỉ để lọc lại danh sách Hợp đồng cho khớp,
  // KHÔNG còn tự gợi ý Đợt/J theo Dự án+Đối tác nữa (dễ nhầm với bill cũ không liên quan)
  modal.querySelector('#fProject').addEventListener('change', () => {
    refreshContractSelect(modal, contracts, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
  });
  modal.querySelector('#fPartner').addEventListener('change', () => {
    refreshContractSelect(modal, contracts, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
  });

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const contract_id = modal.querySelector('#fContract').value || null;
    const partner_id = modal.querySelector('#fPartner').value;
    const period_no = Number(modal.querySelector('#fPeriod').value);
    const scope = modal.querySelector('#fScope').value;
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const val_a = parseMoneyInput(modal.querySelector('#fA').value);
    const val_b = parseMoneyInput(modal.querySelector('#fB').value);
    const { val_d, perCode } = readDValue(dWrap);
    const val_e = parseMoneyInput(modal.querySelector('#fE').value);
    const val_f = parseMoneyInput(modal.querySelector('#fF').value);
    const val_g = parseMoneyInput(modal.querySelector('#fG').value);
    const val_i = parseMoneyInput(modal.querySelector('#fI').value);
    const val_h = parseMoneyInput(modal.querySelector('#fH').value);
    const deduction_note = modal.querySelector('#fDeductNote').value.trim();
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !partner_id || !contract_id || !val_a || (!perCode && !budget_code)) return toast('Điền đủ thông tin bắt buộc (kể cả Đối tác + Hợp đồng liên kết)', 'error');
    if (val_h !== 0 && !deduction_note) return toast('Có giá trị khấu trừ thì phải ghi rõ lý do', 'error');

    // Quy tắc: kỳ N+1 chỉ tạo được khi kỳ N đã DUYỆT XONG (đã thanh toán) — áp dụng đều
    // cho cả 2 kiểu: có liên kết hợp đồng lẫn đi bill tự do theo cặp Dự án+Đối tác.
    // Bill "Hủy" hay "Đang duyệt" đều KHÔNG đủ điều kiện lên kỳ tiếp theo. Nếu kỳ trước
    // đó đã bị Hủy, hệ thống coi như số kỳ đó chưa từng có (findLatestValidBill bỏ qua
    // nó), nên period_no lúc đó sẽ tự nhảy lùi để dùng lại đúng số đã hủy — trường hợp
    // này period_no - 1 sẽ không khớp với latest.period_no, cũng bị chặn ở nhánh dưới.
    if (period_no > 1) {
      const latest = await findLatestValidBill(contract_id, project_id, partner_id);
      if (latest) {
        if (latest.period_no !== period_no - 1) {
          return toast(`Số kỳ không khớp — kỳ hợp lệ mới nhất trong hệ thống là kỳ ${latest.period_no} (không tính bill đã hủy), phải tạo kỳ ${latest.period_no + 1} tiếp theo`, 'error');
        }
        if (latest.status !== 'paid') {
          return toast(`Bill kỳ ${period_no - 1} chưa duyệt xong (đang ${BILL_STATUS_LABEL[latest.status] || latest.status}) — chưa tạo được kỳ ${period_no}`, 'error');
        }
      }
      // latest === null -> chưa có bill hợp lệ nào cho hồ sơ này -> đây là bill đầu tiên
      // nhập vào hệ thống (có thể ngoài đời đã tới kỳ N), cho phép nhập tự do
    }

    loading(true);
    // Lưu ý: fn_create_bill (RPC) hiện chưa biết tới val_e/val_g (giữ lại/hoàn trả tạm ứng
    // nhập tay bằng VNĐ) — vẫn gửi p_retention_rate = 0 cho đủ tham số hàm cũ (không còn
    // dùng để tính toán), rồi UPDATE thẳng val_e/val_g ngay sau khi tạo xong — giống hệt
    // cách bill_budget_lines đang được thêm sau khi có newBillId, không cần sửa RPC.
    const { data: newBillId, error } = await supabase.rpc('fn_create_bill', {
      p_project_id: project_id,
      p_contract_id: contract_id,
      p_partner_id: partner_id,
      p_period_no: period_no,
      p_scope: scope,
      p_signed_date: signed_date,
      p_val_a: val_a,
      p_val_b: val_b,
      p_val_d: val_d,
      p_val_f: val_f,
      p_val_i: val_i,
      p_val_h: val_h,
      p_deduction_note: deduction_note || null,
      p_retention_rate: 0,
      p_vat_rate: vat_rate,
      p_checklist_required: 0, // tạm bỏ ô nhập checklist khỏi form — không bắt buộc đính kèm gì cho tới khi bật lại
      p_template_id: template_id || null,
    });
    if (error) {
      if (error.message.includes('bills_require_contract_when_editable')) return toast('Bắt buộc phải chọn Hợp đồng liên kết trước khi lưu/trình bill.', 'error');
      if (error.message.includes('bills_doc_number_unique')) return toast('Số bill này đã tồn tại — thử lại (có thể trùng do 2 người thao tác cùng lúc).', 'error');
      return toast('Lỗi tạo bill: ' + error.message, 'error');
    }
    const newBill = { id: newBillId };
    await supabase.from('bills').update({ val_e, val_g }).eq('id', newBill.id);

    // Chia mã ngân sách: nếu hợp đồng có nhiều mã, lưu đúng từng phần D theo mã (không lưu K —
    // K là số tiền thanh toán thực tế đã trừ tạm ứng/giữ lại, không phản ánh đúng "đã dùng ngân sách");
    // nếu chỉ 1 mã, lưu D của mã đó
    const linesToSave = perCode && perCode.length ? perCode : [{ budget_code, value: val_d }];
    await supabase.from('bill_budget_lines').insert(linesToSave.map((l) => ({ bill_id: newBill.id, budget_code: l.budget_code, value: l.value })));
    await uploadStagedFiles(filePicker.getFiles(), 'bill', newBill.id, user.id);

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'bill', p_doc_id: newBill.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình bill', 'success');
      closeModal(modal, onClose);
    } else {
      toast('Đã lưu nháp — mở lại hồ sơ để đính kèm file', 'success');
      closeModal(modal, () => {}); // đóng form tạo, không refresh danh sách vội
      openDetail(newBill.id, user, onClose); // mở luôn chi tiết để đính kèm file ngay
    }
  }

  modal.querySelector('#btnSaveDraft').addEventListener('click', () => doSave(false));
  modal.querySelector('#btnSubmitNew').addEventListener('click', () => doSave(true));
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
function showModal(modal, onClose, hashOverride) {
  modal.classList.add('show');
  modal.scrollTop = 0; // đưa về đúng đầu trang — phòng trình duyệt di động giữ vị trí cuộn cũ
  pushModalHistory(hashOverride);
  // Cố tình KHÔNG đóng khi bấm ra ngoài — tránh mất dữ liệu đang nhập nếu lỡ tay bấm trượt.
  // Chỉ đóng bằng nút X (hoặc nút Hủy/nút quay lại chi tiết).
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
