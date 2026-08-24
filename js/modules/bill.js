// ============================================================
// bill.js — Module Bill thanh toán theo kỳ
// Công thức: C=A+B | E=-10%×D | G = F==0 ? 0 : -F×(D/(0.8×A)) | H=D+E+F+G | J=H+I
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, budgetLineRowHtml, wireBudgetLines, readBudgetLines } from '../core/approvalUI.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';

function calcBill(b, contract) {
  const vatRate = (b.vat_rate ?? contract?.vat_rate ?? 8) / 100;
  const retentionRate = (b.retention_rate ?? contract?.retention_rate ?? 10) / 100;
  const C = Number(b.val_a) + Number(b.val_b);
  const VAT = Number(b.val_d) * vatRate;
  const E = -retentionRate * Number(b.val_d);
  const G = Number(b.val_f) === 0 ? 0 : -Number(b.val_f) * (Number(b.val_d) / (0.8 * Number(b.val_a)));
  const H = Number(b.val_h) || 0;
  const I = Number(b.val_d) + E + Number(b.val_f) + G + H;
  const K = I + Number(b.val_i); // "J" trên chứng từ = val_i trong database (giữ tên cột cũ, chỉ đổi nhãn hiển thị)
  return { C, VAT, E, G, H, I, K };
}

// Khi hợp đồng liên kết có NHIỀU mã ngân sách, tách D thành nhiều ô nhập theo từng mã
// (tổng các ô = D) — khớp đúng cách hợp đồng đã chia từ đầu, không nhập gộp 1 số nữa
function renderDSection(wrapEl, contractLines, prefillLines) {
  const isMulti = contractLines && contractLines.length > 1;
  if (!isMulti) {
    const prefill = prefillLines?.[0]?.value ?? '';
    wrapEl.innerHTML = `<label class="form-label">D — Lũy kế thực hiện kỳ này (chưa VAT)</label>
      <input type="text" inputmode="numeric" id="fD" class="form-input money-input" value="${prefill ? formatMoneyInput(prefill) : ''}">`;
    return;
  }
  wrapEl.innerHTML = `<label class="form-label">D — Lũy kế thực hiện theo từng mã ngân sách (chưa VAT)</label>
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

// Kỳ số khóa theo đúng thứ tự lũy kế, J tự = -D của kỳ liền trước (trừ Kỳ 1 vẫn tự nhập tay)
// Nếu CHƯA có hợp đồng liên kết (đi bill trước, làm hợp đồng bù sau) — vẫn theo dõi được,
// tạm dùng cặp Dự án + Đối tác làm "chuỗi tạm" cho tới khi có hợp đồng thật
async function updateKyAndJ(modal, contractId, projectId, partnerId) {
  const periodInput = modal.querySelector('#fPeriod');
  const jInput = modal.querySelector('#fI');

  let existingBills = [];
  if (contractId) {
    const { data } = await supabase.from('bills').select('period_no, val_d').eq('contract_id', contractId).order('period_no', { ascending: false });
    existingBills = data || [];
  } else if (projectId && partnerId) {
    const { data } = await supabase
      .from('bills')
      .select('period_no, val_d')
      .is('contract_id', null)
      .eq('project_id', projectId)
      .eq('partner_id', partnerId)
      .order('period_no', { ascending: false });
    existingBills = data || [];
  } else {
    periodInput.readOnly = false;
    periodInput.style.background = '';
    jInput.readOnly = false;
    jInput.style.background = '';
    return;
  }

  const maxPeriod = existingBills.length ? existingBills[0].period_no : 0;
  const nextPeriod = maxPeriod + 1;

  periodInput.value = nextPeriod;
  periodInput.readOnly = true;
  periodInput.style.background = 'var(--gray1)';

  if (nextPeriod === 1) {
    jInput.value = '0';
    jInput.readOnly = false;
    jInput.style.background = '';
  } else {
    const prevBill = existingBills.find((b) => b.period_no === nextPeriod - 1);
    jInput.value = formatMoneyInput(prevBill ? -Number(prevBill.val_d) : 0);
    jInput.readOnly = true;
    jInput.style.background = 'var(--gray1)';
  }
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  let q = supabase
    .from('bills')
    .select('id, doc_number, period_no, val_a, val_b, val_d, val_f, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name)')
    .order('created_at', { ascending: false });
  if (VIEW_PROJECT !== 'ALL') q = q.eq('project_id', VIEW_PROJECT);
  const { data: bills, error } = await q;

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
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btnNew">+ Trình bill thanh toán</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Số hồ sơ</th><th>Đối tác</th><th>Kỳ</th><th>Đề nghị (K)</th><th>Checklist</th><th>Trạng thái</th></tr></thead><tbody>
    ${sorted.length ? sorted.map((b) => {
      const { K } = calcBill(b);
      const req = b.checklist_required || 0;
      const done = b.checklist_done || 0;
      return `<tr class="click" data-id="${b.id}"><td class="mono">${b.doc_number}</td><td>${b.partners?.name || '—'}</td><td>Kỳ ${b.period_no}</td>
      <td class="mono">${fmt(K)}</td><td>${req ? (done < req ? `<span style="color:var(--amber)">${done}/${req} ⚠️</span>` : `<span style="color:var(--green)">${done}/${req} ✓</span>`) : '—'}</td>
      <td>${statusBadge(b.status)}</td></tr>`;
    }).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray4);padding:20px">Chưa có bill nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
}

function finRow(label, value, code, bold) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--gray1);${bold ? 'font-weight:700;' : ''}">
    <span style="font-size:12.5px;color:${bold ? 'var(--gray8)' : 'var(--gray7)'}">${label}</span>
    <span style="display:flex;align-items:center;gap:10px">
      <span class="mono" style="font-size:13px;${bold ? 'font-weight:700;color:var(--navy)' : ''}">${value === 0 ? '—' : fmt(value) + ' ₫'}</span>
      <span style="font-size:10.5px;color:var(--gray4);width:60px;text-align:left">${code}</span>
    </span></div>`;
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose, `bill/${id}`);

  const { data: b } = await supabase
    .from('bills')
    .select('*, partners(name), projects(name), contracts(doc_number, value, retention_rate, vat_rate), bill_budget_lines(budget_code, value)')
    .eq('id', id)
    .single();
  if (!b) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ.</div>`;
    return;
  }
  const r = calcBill(b, b.contracts);
  const { assignments, logs } = await loadApprovalState('bill', id);
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
  const isKscp = (user.roles || []).some((r) => ['Admin', 'QLCPHD_CV', 'QLCPHD_TP'].includes(r));
  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${b.doc_number}</div><div class="meta">Kỳ ${b.period_no} · ${b.partners?.name || '—'}</div></div>
      <div style="display:flex;gap:6px;align-items:center">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        ${isKscp ? `<button class="btn btn-sm btn-secondary" id="btnEditBudgetLines">🧮 Sửa mã ngân sách</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      ${b.contract_ceiling_flag ? `<div class="warn-box">⚠️ <div><b>Case 1 — Lũy kế thực hiện đã vượt giá trị hợp đồng.</b> Vẫn duyệt bình thường; cần bổ sung phụ lục hợp đồng để hợp thức hóa.</div></div>` : ''}
      <div class="kv">
        <div class="k">Gói thầu</div><div class="v" style="font-weight:600">${b.scope || '—'}</div>
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
        ${finRow('Giá trị thực hiện lũy kế đến kỳ này (chưa VAT)', b.val_d, 'D')}
        ${finRow(`VAT (${b.vat_rate}%)`, r.VAT, '= D×VAT%')}
        ${finRow(`Tổng giá trị tiền giữ lại (${b.retention_rate}%)`, r.E, 'E')}
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
      ${b.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, b.current_step)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp.</div>`}
    </div>
    ${actionFooterHtml(b, 'bill', user, assignments)}
  `;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(b, user, onClose));
  box.querySelector('#btnEditBudgetLines')?.addEventListener('click', () => openBudgetLinesEditor(b, user, onClose));
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
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, value_adjustment, project_id, partner_id, retention_rate, vat_rate').eq('status', 'active').order('doc_number');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: currentLines } = await supabase.from('bill_budget_lines').select('budget_code, value').eq('bill_id', bill.id);
  const currentBudgetCode = currentLines?.[0]?.budget_code || '';

  // Nếu hợp đồng liên kết có nhiều mã, cần biết trước để vẽ đúng dSection nhiều dòng ngay từ đầu
  let contractLinesForBill = null;
  if (bill.contract_id) {
    const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', bill.contract_id);
    if (cLines && cLines.length > 1) contractLinesForBill = cLines;
  }

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa bill — ${bill.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}" ${p.id === bill.project_id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Hợp đồng liên kết (không bắt buộc)</label>
        <select id="fContract" class="form-input"><option value="">— Chưa liên kết —</option>${(contracts || []).map((c) => `<option value="${c.id}" ${c.id === bill.contract_id ? 'selected' : ''} data-value="${c.value}" data-adj="${c.value_adjustment || 0}" data-partner="${c.partner_id}" data-retention="${c.retention_rate}" data-vat="${c.vat_rate}">${c.doc_number}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC) *</label>
        <select id="fPartner" class="form-input">${(partners || []).map((p) => `<option value="${p.id}" ${p.id === bill.partner_id ? 'selected' : ''}>${p.name} (MST ${p.mst})</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Kỳ số</label>
        <input type="number" id="fPeriod" class="form-input" value="${bill.period_no}" min="1"></div>
      <div style="margin-bottom:13px"><label class="form-label">Gói thầu / nội dung kỳ này</label>
        <input type="text" id="fScope" class="form-input" value="${bill.scope || ''}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">A — Giá trị HĐ ban đầu (có VAT)</label><input type="text" inputmode="numeric" id="fA" class="form-input money-input" value="${formatMoneyInput(bill.val_a)}"></div>
        <div><label class="form-label">B — Điều chỉnh HĐ (có VAT)</label><input type="text" inputmode="numeric" id="fB" class="form-input money-input" value="${formatMoneyInput(bill.val_b)}"></div>
        <div><label class="form-label">F — Giá trị tạm ứng</label><input type="text" inputmode="numeric" id="fF" class="form-input money-input" value="${formatMoneyInput(bill.val_f)}"></div>
        <div><label class="form-label">Tỉ lệ giữ lại (%)</label><input type="number" id="fRetention" class="form-input" value="${bill.retention_rate}" step="0.1"></div>
        <div><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="${bill.vat_rate}" step="0.1"></div>
        <div><label class="form-label">H — Giá trị khấu trừ</label><input type="text" inputmode="numeric" id="fH" class="form-input money-input" value="${formatMoneyInput(bill.val_h || 0)}"></div>
        <div style="grid-column:1/-1"><label class="form-label">J — Trừ các đợt thanh toán trước (số âm)</label><input type="text" inputmode="numeric" id="fI" class="form-input money-input" value="${formatMoneyInput(bill.val_i)}"></div>
      </div>
      <div id="dSectionWrap" style="margin-bottom:13px"></div>
      <div style="margin-bottom:13px"><label class="form-label">Lý do khấu trừ (bắt buộc nếu H khác 0)</label>
        <input type="text" id="fDeductNote" class="form-input" value="${bill.deduction_note || ''}"></div>
      <div id="singleBudgetCodeWrap" style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}" ${c.code === currentBudgetCode ? 'selected' : ''}>${c.code} — ${c.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Số hồ sơ đính kèm bắt buộc (checklist)</label>
        <input type="number" id="fChecklist" class="form-input" value="${bill.checklist_required || 0}" min="0"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(bill.id, user, onClose));

  const dWrap = modal.querySelector('#dSectionWrap');
  renderDSection(dWrap, contractLinesForBill, currentLines);
  modal.querySelector('#singleBudgetCodeWrap').style.display = contractLinesForBill ? 'none' : '';

  modal.querySelector('#fContract').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.value) {
      modal.querySelector('#fA').value = opt.dataset.value || '';
      modal.querySelector('#fB').value = opt.dataset.adj || 0;
      if (opt.dataset.partner) modal.querySelector('#fPartner').value = opt.dataset.partner;
      if (opt.dataset.retention) modal.querySelector('#fRetention').value = opt.dataset.retention;
      if (opt.dataset.vat) modal.querySelector('#fVat').value = opt.dataset.vat;

      const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', opt.value);
      renderDSection(dWrap, cLines, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = cLines && cLines.length > 1 ? 'none' : '';
      await updateKyAndJ(modal, opt.value, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    } else {
      renderDSection(dWrap, null, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = '';
      await updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });

  // Chưa chọn hợp đồng (đi bill trước) — đổi Dự án/Đối tác cũng cần tính lại Kỳ/J theo đúng cặp đó
  modal.querySelector('#fProject').addEventListener('change', () => {
    if (!modal.querySelector('#fContract').value) {
      updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });
  modal.querySelector('#fPartner').addEventListener('change', () => {
    if (!modal.querySelector('#fContract').value) {
      updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const contract_id = modal.querySelector('#fContract').value || null;
    const partner_id = modal.querySelector('#fPartner').value;
    const period_no = Number(modal.querySelector('#fPeriod').value);
    const scope = modal.querySelector('#fScope').value;
    const val_a = parseMoneyInput(modal.querySelector('#fA').value);
    const val_b = parseMoneyInput(modal.querySelector('#fB').value);
    const { val_d, perCode } = readDValue(dWrap);
    const val_f = parseMoneyInput(modal.querySelector('#fF').value);
    const val_i = parseMoneyInput(modal.querySelector('#fI').value);
    const val_h = parseMoneyInput(modal.querySelector('#fH').value);
    const deduction_note = modal.querySelector('#fDeductNote').value.trim();
    const retention_rate = Number(modal.querySelector('#fRetention').value);
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const checklist_required = Number(modal.querySelector('#fChecklist').value);

    if (!project_id || !partner_id || !val_a || (!perCode && !budget_code)) return toast('Điền đủ thông tin bắt buộc (kể cả Đối tác)', 'error');
    if (val_h !== 0 && !deduction_note) return toast('Có giá trị khấu trừ thì phải ghi rõ lý do', 'error');

    loading(true);
    const { error } = await supabase
      .from('bills')
      .update({ project_id, contract_id, partner_id, period_no, scope, val_a, val_b, val_d, val_f, val_i, val_h, deduction_note: deduction_note || null, retention_rate, vat_rate, checklist_required })
      .eq('id', bill.id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

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
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, value_adjustment, project_id, partner_id, retention_rate, vat_rate').eq('status', 'active').order('doc_number');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'bill');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Trình bill thanh toán mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Hợp đồng liên kết (không bắt buộc)</label>
        <select id="fContract" class="form-input"><option value="">— Chưa liên kết —</option>${(contracts || []).map((c) => `<option value="${c.id}" data-value="${c.value}" data-adj="${c.value_adjustment || 0}" data-partner="${c.partner_id}" data-retention="${c.retention_rate}" data-vat="${c.vat_rate}">${c.doc_number}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chọn hợp đồng sẽ tự điền A, B, Đối tác, % giữ lại, % VAT theo đúng hợp đồng đó.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC) *</label>
        <select id="fPartner" class="form-input">${(partners || []).map((p) => `<option value="${p.id}">${p.name} (MST ${p.mst})</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Kỳ số</label>
        <input type="number" id="fPeriod" class="form-input" value="1" min="1"></div>
      <div style="margin-bottom:13px"><label class="form-label">Gói thầu / nội dung kỳ này</label>
        <input type="text" id="fScope" class="form-input" placeholder="VD: Cung cấp bê tông tươi mác 300"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">A — Giá trị HĐ ban đầu (có VAT)</label><input type="text" inputmode="numeric" id="fA" class="form-input money-input"></div>
        <div><label class="form-label">B — Điều chỉnh HĐ (có VAT)</label><input type="text" inputmode="numeric" id="fB" class="form-input money-input" value="0"></div>
        <div><label class="form-label">F — Giá trị tạm ứng</label><input type="text" inputmode="numeric" id="fF" class="form-input money-input" value="0"></div>
        <div><label class="form-label">Tỉ lệ giữ lại (%)</label><input type="number" id="fRetention" class="form-input" value="10" step="0.1"></div>
        <div><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="8" step="0.1"></div>
        <div><label class="form-label">H — Giá trị khấu trừ</label><input type="text" inputmode="numeric" id="fH" class="form-input money-input" value="0"></div>
        <div style="grid-column:1/-1"><label class="form-label">J — Trừ các đợt thanh toán trước (số âm)</label><input type="text" inputmode="numeric" id="fI" class="form-input money-input" value="0">
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Kỳ 1: tự nhập tay. Từ kỳ 2: tự khóa, lấy đúng -D của kỳ liền trước.</div></div>
      </div>
      <div id="dSectionWrap" style="margin-bottom:13px"></div>
      <div style="margin-bottom:13px" id="deductNoteWrap"><label class="form-label">Lý do khấu trừ (bắt buộc nếu H khác 0)</label>
        <input type="text" id="fDeductNote" class="form-input" placeholder="VD: Phạt chậm tiến độ 5 ngày"></div>
      <div id="singleBudgetCodeWrap" style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">"Dự trù tài chính" sẽ tự lấy theo đúng Ngân sách phân bổ của mã này, không cần nhập tay.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Số hồ sơ đính kèm bắt buộc (checklist)</label>
        <input type="number" id="fChecklist" class="form-input" value="5" min="0"></div>
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

  const filePicker = renderFilePicker(modal.querySelector('#filePickerWrap'));
  const dWrap = modal.querySelector('#dSectionWrap');
  renderDSection(dWrap, null, null); // mặc định: chưa chọn hợp đồng -> D đơn giản

  // Khi chọn hợp đồng liên kết, tự điền A, B, Đối tác, % giữ lại, % VAT, và tách D theo mã nếu hợp đồng có nhiều mã
  modal.querySelector('#fContract').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.value) {
      modal.querySelector('#fA').value = opt.dataset.value || '';
      modal.querySelector('#fB').value = opt.dataset.adj || 0;
      if (opt.dataset.partner) modal.querySelector('#fPartner').value = opt.dataset.partner;
      if (opt.dataset.retention) modal.querySelector('#fRetention').value = opt.dataset.retention;
      if (opt.dataset.vat) modal.querySelector('#fVat').value = opt.dataset.vat;

      const { data: cLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', opt.value);
      renderDSection(dWrap, cLines, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = cLines && cLines.length > 1 ? 'none' : '';
      await updateKyAndJ(modal, opt.value, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    } else {
      renderDSection(dWrap, null, null);
      modal.querySelector('#singleBudgetCodeWrap').style.display = '';
      await updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });

  // Chưa chọn hợp đồng (đi bill trước) — đổi Dự án/Đối tác cũng cần tính lại Kỳ/J theo đúng cặp đó
  modal.querySelector('#fProject').addEventListener('change', () => {
    if (!modal.querySelector('#fContract').value) {
      updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });
  modal.querySelector('#fPartner').addEventListener('change', () => {
    if (!modal.querySelector('#fContract').value) {
      updateKyAndJ(modal, null, modal.querySelector('#fProject').value, modal.querySelector('#fPartner').value);
    }
  });

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const contract_id = modal.querySelector('#fContract').value || null;
    const partner_id = modal.querySelector('#fPartner').value;
    const period_no = Number(modal.querySelector('#fPeriod').value);
    const scope = modal.querySelector('#fScope').value;
    const val_a = parseMoneyInput(modal.querySelector('#fA').value);
    const val_b = parseMoneyInput(modal.querySelector('#fB').value);
    const { val_d, perCode } = readDValue(dWrap);
    const val_f = parseMoneyInput(modal.querySelector('#fF').value);
    const val_i = parseMoneyInput(modal.querySelector('#fI').value);
    const val_h = parseMoneyInput(modal.querySelector('#fH').value);
    const deduction_note = modal.querySelector('#fDeductNote').value.trim();
    const retention_rate = Number(modal.querySelector('#fRetention').value);
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const checklist_required = Number(modal.querySelector('#fChecklist').value);
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !partner_id || !val_a || (!perCode && !budget_code)) return toast('Điền đủ thông tin bắt buộc (kể cả Đối tác)', 'error');
    if (val_h !== 0 && !deduction_note) return toast('Có giá trị khấu trừ thì phải ghi rõ lý do', 'error');

    // Quy tắc: kỳ N+1 chỉ tạo được khi kỳ N đã qua tối thiểu bước 2
    if (contract_id && period_no > 1) {
      const { data: prevBill } = await supabase
        .from('bills')
        .select('current_step, status')
        .eq('contract_id', contract_id)
        .eq('period_no', period_no - 1)
        .maybeSingle();
      if (!prevBill) return toast(`Chưa có bill kỳ ${period_no - 1} của hợp đồng này — phải tạo kỳ trước đó trước`, 'error');
      if (prevBill.status === 'draft' || prevBill.current_step < 2) {
        return toast(`Bill kỳ ${period_no - 1} chưa qua tối thiểu bước 2 — chưa tạo được kỳ ${period_no}`, 'error');
      }
    }

    loading(true);
    const { data: newBill, error } = await supabase
      .from('bills')
      .insert({ project_id, contract_id, partner_id, period_no, scope, val_a, val_b, val_d, val_f, val_i, val_h, deduction_note: deduction_note || null, retention_rate, vat_rate, checklist_required, template_id: template_id || null, created_by: user.id, status: 'draft' })
      .select('id')
      .single();
    if (error) return toast('Lỗi tạo bill: ' + error.message, 'error');

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
