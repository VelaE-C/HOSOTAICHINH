// ============================================================
// bill.js — Module Bill thanh toán theo kỳ
// Công thức: C=A+B | E=-10%×D | G = F==0 ? 0 : -F×(D/(0.8×A)) | H=D+E+F+G | J=H+I
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, budgetLineRowHtml, wireBudgetLines, readBudgetLines, loadStepPreview } from '../core/approvalUI.js';
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

  if (existingBills.length === 0) {
    // Chưa có bill nào trong hệ thống cho đúng hợp đồng/cặp này — có thể đây là bill
    // ĐẦU TIÊN nhập vào hệ thống của 1 hồ sơ đã có sẵn ngoài đời (VD thực tế đang ở
    // Kỳ 4) -> mở cho nhập tay tự do, không ép về Kỳ 1. Bill tiếp theo sau đó sẽ tự
    // động nối tiếp đúng từ số vừa nhập (n+1), như bình thường.
    if (!periodInput.value) periodInput.value = '1';
    periodInput.readOnly = false;
    periodInput.style.background = '';
    periodInput.title = 'Chưa có bill nào trong hệ thống cho hồ sơ này — nhập đúng kỳ thực tế (VD nếu đã tới Kỳ 4 ngoài đời, nhập 4).';
    if (!jInput.value) jInput.value = '0';
    jInput.readOnly = false;
    jInput.style.background = '';
    return;
  }

  const nextPeriod = existingBills[0].period_no + 1;

  periodInput.value = nextPeriod;
  periodInput.readOnly = true;
  periodInput.style.background = 'var(--gray1)';
  periodInput.title = '';

  const prevBill = existingBills.find((b) => b.period_no === nextPeriod - 1);
  jInput.value = formatMoneyInput(prevBill ? -Number(prevBill.val_d) : 0);
  jInput.readOnly = true;
  jInput.style.background = 'var(--gray1)';
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: bills, error }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    (VIEW_PROJECT !== 'ALL'
      ? supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_f, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name)').eq('project_id', VIEW_PROJECT)
      : supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_f, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name)')
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
        <tr><td class="label">Số bill</td><td>${b.doc_number} — Kỳ ${b.period_no}</td></tr>
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
        <tr><td class="label">D — Thực hiện lũy kế (chưa VAT)</td><td class="num">${vnMoney(b.val_d)}</td></tr>
        <tr><td class="label">VAT (${b.vat_rate}%)</td><td class="num">${vnMoney(r.VAT)}</td></tr>
        <tr><td class="label">E — Giữ lại bảo hành (${b.retention_rate}%)</td><td class="num">${vnMoney(r.E)}</td></tr>
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
    <div class="panel-header"><div><div>${b.doc_number}</div><div class="meta">Kỳ ${b.period_no} · ${b.partners?.name || '—'}</div></div>
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
      ${b.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, b.current_step, preview)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp.</div>`}
    </div>
    ${actionFooterHtml(b, 'bill', user, assignments)}
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
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input" value="${bill.signed_date || ''}"></div>
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
    const signed_date = modal.querySelector('#fSignedDate').value || null;
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
      .update({ project_id, contract_id, partner_id, period_no, scope, signed_date, val_a, val_b, val_d, val_f, val_i, val_h, deduction_note: deduction_note || null, retention_rate, vat_rate, checklist_required })
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
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input"></div>
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
    const signed_date = modal.querySelector('#fSignedDate').value || null;
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
      p_retention_rate: retention_rate,
      p_vat_rate: vat_rate,
      p_checklist_required: checklist_required,
      p_template_id: template_id || null,
    });
    if (error) return toast('Lỗi tạo bill: ' + error.message, 'error');
    const newBill = { id: newBillId };

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
