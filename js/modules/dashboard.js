// ============================================================
// dashboard.js — Tổng quan: Ngân sách/Cam kết/Thực chi, HĐ CĐT vs ngân sách,
// danh sách hồ sơ vượt (Case 1/2), danh sách đơn vị đã ký hợp đồng.
// Toàn bộ dữ liệu lấy thật từ Supabase — RLS tự lọc đúng phạm vi theo vai trò
// đang đăng nhập, module này không cần tự kiểm tra quyền.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, tyi, budgetColor, toast, IS_MOBILE } from '../core/utils.js';

// Chống vỡ HTML khi tên đối tác/dự án có ký tự đặc biệt (&, <, ">, dấu nháy)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill', totrinh: 'Tờ trình', bctc: 'BCTC' };

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải dữ liệu…</div>`;

  const isTopLevel = (user.roles || []).some((r) => ['QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'].includes(r));

  const [{ data: projects }, { data: budgetRows }, { data: revenueRows }, { data: flagged }, { data: contracts }, { data: bills }, { data: myAssignments }, { data: overdueRaw }, { data: myDeptRoles }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
      supabase.from('v_budget_summary').select('*'),
      supabase.from('revenue_contracts').select('project_id, investor, value'),
      supabase.from('v_flagged_documents').select('*'),
      // Bổ sung status / parent_contract_id / projects(code,name) để bảng cảnh báo
      // tra được Dự án, Nhà cung cấp và cộng dồn PLHĐ mà không phải gọi thêm query
      supabase.from('contracts').select('id, doc_number, value, status, parent_contract_id, project_id, origin_department, partners(name), projects(code, name)'),
      // Bổ sung id / doc_number để đối chiếu đúng dòng cảnh báo là bill nào
      supabase.from('bills').select('id, doc_number, contract_id, val_d'),
      supabase.from('project_role_assignments').select('role_type, project_id, projects(code)').eq('user_id', user.id).is('effective_to', null),
      isTopLevel
        ? supabase.from('approval_assignments').select('document_type, document_id, step_no, created_at, users(full_name)').eq('status', 'pending')
        : Promise.resolve({ data: [] }),
      supabase.from('user_roles').select('department').eq('user_id', user.id).eq('role_type', 'TruongPhongChucNang'),
    ]);

  // Khối "Vai trò của tôi" — tra cứu nhanh đang giữ vị trí gì, ở đâu, không cần lật từng hồ sơ
  const myRoleChips = [
    ...(user.roles || [])
      .filter((r) => !['CHT', 'GDDA', 'PTGD', 'QS'].includes(r)) // vai trò gắn dự án hiện riêng bên dưới, tránh trùng
      .map((r) => `<span class="code-chip">${r}</span>`),
    ...(myAssignments || []).map((a) => `<span class="code-chip">${a.role_type} — ${a.projects?.code || '—'}</span>`),
  ];
  const myRolesHtml = myRoleChips.length
    ? `<div class="card" style="margin-bottom:16px"><div class="card-sub" style="margin-bottom:8px">Vai trò của tôi</div><div style="display:flex;flex-wrap:wrap;gap:6px">${myRoleChips.join('')}</div></div>`
    : '';

  if (!projects || projects.length === 0) {
    container.innerHTML = myRolesHtml + `<div class="empty-note">Chưa có dự án nào trong hệ thống, hoặc bạn chưa được phân công dự án nào.</div>`;
    return;
  }

  // Ngân sách/HĐ đầu ra giờ ai cũng xem được, nhưng nếu người này CÓ gắn với
  // (các) dự án cụ thể (CHT/GĐDA/QS/PTGD-công trường...) thì chỉ hiện đúng
  // dự án đó — vai trò văn phòng thuần (Kế toán/Pháp chế/QLCP&HĐ không gắn dự án
  // cụ thể) vẫn thấy toàn bộ như trước, đúng vai trò xuyên suốt của họ.
  const myProjectIds = new Set((myAssignments || []).map((a) => a.project_id).filter(Boolean));
  const isSiteLimited = myProjectIds.size > 0 && !(user.roles || []).some((r) => ['QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'].includes(r));

  // Trưởng phòng chức năng: tương đương GĐDA nhưng của PHÒNG BAN thay vì DỰ ÁN —
  // chỉ thấy đúng hồ sơ do phòng mình trình (dựa vào origin_department, tự ghi lúc
  // trình). Ngân sách/Doanh thu vốn là khái niệm THEO DỰ ÁN, phòng ban không sở hữu
  // ngân sách riêng, nên KHÔNG hiện các khối đó cho diện này (tránh số liệu vô nghĩa).
  const myDept = (myDeptRoles || [])[0]?.department || null;
  const isDeptLimited = !isSiteLimited && !isTopLevel && !!myDept;

  const budgetRowsFiltered = isSiteLimited ? (budgetRows || []).filter((r) => myProjectIds.has(r.project_id)) : isDeptLimited ? [] : budgetRows;
  const revenueRowsFiltered = isSiteLimited ? (revenueRows || []).filter((r) => myProjectIds.has(r.project_id)) : isDeptLimited ? [] : revenueRows;
  const contractsFiltered = isSiteLimited ? (contracts || []).filter((c) => myProjectIds.has(c.project_id)) : isDeptLimited ? (contracts || []).filter((c) => c.origin_department === myDept) : contracts;

  // Tổng hợp ngân sách 3 lớp — giờ ai cũng xem được (đã mở RLS), lọc theo dự án nếu cần
  const totBudget = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.allocated_value || 0), 0);
  const totCommit = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.committed || 0), 0);
  const totActual = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.actual_spend || 0), 0);
  const totRevenue = (revenueRowsFiltered || []).reduce((s, r) => s + Number(r.value || 0), 0);
  const delta = totRevenue - totBudget;

  // Danh sách đơn vị đã ký hợp đồng — so với lũy kế bill (Case 1 ngay trong tầm mắt)
  const lũyKeByContract = {};
  (bills || []).forEach((b) => {
    if (!b.contract_id) return;
    lũyKeByContract[b.contract_id] = Math.max(lũyKeByContract[b.contract_id] || 0, Number(b.val_d || 0));
  });
  const unitRows = (contractsFiltered || []).map((c) => {
    const lũyKe = lũyKeByContract[c.id] || 0;
    return { partner: c.partners?.name || '—', docNumber: c.doc_number, value: c.value, lũyKe, left: c.value - lũyKe, over: lũyKe > c.value };
  });

  // ============================================================
  // BẢNG "HỒ SƠ ĐANG CÓ CẢNH BÁO" — dựng dữ liệu
  // View v_flagged_documents chỉ trả về loại/số hồ sơ/lý do, nên Dự án và Nhà
  // cung cấp được tra ngược từ danh sách contracts/bills đã tải sẵn ở trên
  // (không tốn thêm truy vấn). Ưu tiên khớp theo id, không có thì khớp theo
  // số hồ sơ — doc_number là duy nhất trong từng bảng.
  // ============================================================
  const contractById = Object.fromEntries((contracts || []).map((c) => [c.id, c]));
  const contractByNumber = Object.fromEntries((contracts || []).map((c) => [c.doc_number, c]));
  const billById = Object.fromEntries((bills || []).map((b) => [b.id, b]));
  const billByNumber = Object.fromEntries((bills || []).map((b) => [b.doc_number, b]));

  // PLHĐ con của từng hợp đồng gốc (bỏ PLHĐ đã hủy) — để tính đúng "giá trị hợp
  // đồng sau điều chỉnh", vì Case 1 phải so lũy kế bill với giá trị ĐÃ cộng PLHĐ
  const plhdByParent = {};
  (contracts || []).forEach((c) => {
    if (!c.parent_contract_id || c.status === 'cancelled') return;
    (plhdByParent[c.parent_contract_id] = plhdByParent[c.parent_contract_id] || []).push(c);
  });
  const plhdSum = (contractId) => (plhdByParent[contractId] || []).reduce((s, k) => s + Number(k.value || 0), 0);
  const adjustedValue = (c) => (c ? Number(c.value || 0) + plhdSum(c.id) : 0);

  const flaggedRows = (flagged || []).map((f, i) => {
    const docType = f.doc_type || 'contract';
    const isContract = docType === 'contract';
    const rawId = f.doc_id || f.document_id || f.id || null;
    const rec = isContract ? contractById[rawId] || contractByNumber[f.doc_number] || null : billById[rawId] || billByNumber[f.doc_number] || null;
    // Bill lấy Dự án + NCC theo đúng hợp đồng nó đang thanh toán
    const contract = isContract ? rec : rec ? contractById[rec.contract_id] || null : null;
    return {
      idx: i,
      docType,
      typeLabel: DOC_TYPE_LABEL[docType] || docType,
      docNumber: f.doc_number || '—',
      reason: f.flag_reason || '—',
      projectCode: contract?.projects?.code || '—',
      projectName: contract?.projects?.name || '',
      partner: contract?.partners?.name || '—',
      recId: rec?.id || null,
      contract,
      bill: isContract ? null : rec,
    };
  });
  // Gom theo dự án cho dễ đọc khi đang xem nhiều dự án cùng lúc
  flaggedRows.sort((a, b) => a.projectCode.localeCompare(b.projectCode, 'vi') || a.docType.localeCompare(b.docType) || a.docNumber.localeCompare(b.docNumber, 'vi'));
  const flaggedProjects = [...new Set(flaggedRows.map((r) => r.projectCode))].filter((c) => c !== '—').sort((a, b) => a.localeCompare(b, 'vi'));

  // Dòng chi tiết bung ra khi bấm — chỉ hiện đúng các con số của CHÍNH cảnh báo đó
  function flagDetailHtml(r) {
    const kv = (k, v, style = '') => `<div style="color:var(--gray5)">${k}</div><div class="mono" style="${style}">${v}</div>`;
    let body = '';
    if (r.docType === 'contract' && r.contract) {
      const c = r.contract;
      const kids = plhdByParent[c.id] || [];
      const adj = adjustedValue(c);
      const lk = lũyKeByContract[c.id] || 0;
      const over = lk - adj;
      body =
        kv('Giá trị hợp đồng gốc', fmt(c.value) + ' ₫') +
        kv(`Phụ lục đã có (${kids.length})`, (kids.length ? (plhdSum(c.id) >= 0 ? '+' : '') + fmt(plhdSum(c.id)) + ' ₫' : 'Chưa có PLHĐ nào')) +
        kv('Giá trị HĐ sau điều chỉnh', fmt(adj) + ' ₫', 'font-weight:700') +
        kv('Lũy kế đã bill (cao nhất)', fmt(lk) + ' ₫') +
        kv('Phần vượt', (over > 0 ? fmt(over) + ' ₫' : '—') + (over > 0 && adj > 0 ? ` <span style="color:var(--gray5)">(${((over / adj) * 100).toFixed(1)}%)</span>` : ''), `font-weight:700;color:${over > 0 ? 'var(--red)' : 'var(--green)'}`);
    } else if (r.docType === 'bill') {
      const c = r.contract;
      const adj = adjustedValue(c);
      const lk = Number(r.bill?.val_d || 0);
      const over = lk - adj;
      body =
        kv('Hợp đồng liên kết', c ? esc(c.doc_number) : '<span style="color:var(--amber)">Chưa gắn hợp đồng</span>') +
        kv('Giá trị HĐ sau điều chỉnh', c ? fmt(adj) + ' ₫' : '—', 'font-weight:700') +
        kv('Lũy kế đến đợt này (D)', fmt(lk) + ' ₫') +
        kv('Phần vượt', c && over > 0 ? fmt(over) + ' ₫' + (adj > 0 ? ` <span style="color:var(--gray5)">(${((over / adj) * 100).toFixed(1)}%)</span>` : '') : '—', `font-weight:700;color:${over > 0 ? 'var(--red)' : 'var(--green)'}`);
    } else {
      body = kv('Chi tiết', 'Không tra được hồ sơ gốc — có thể ngoài phạm vi bạn được xem.');
    }
    const hint =
      r.docType === 'contract'
        ? 'Hướng xử lý: tạo Phụ lục hợp đồng bổ sung cho phần vượt, hoặc rà lại giá trị bill đã trình.'
        : 'Hướng xử lý: chờ PLHĐ của hợp đồng được duyệt trước khi duyệt bill này.';
    return `<tr class="flag-detail" id="flag-detail-${r.idx}" style="display:none">
      <td colspan="5" style="background:var(--gray1,#F5F6F8);padding:14px 18px">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 18px;font-size:13px;max-width:560px">${body}</div>
        <div style="font-size:12px;color:var(--gray5);margin-top:10px">${hint}</div>
        ${r.recId ? `<button class="btn btn-sm btn-secondary" data-open="${r.docType}" data-open-id="${r.recId}" style="margin-top:12px">Mở hồ sơ đầy đủ →</button>` : ''}
      </td></tr>`;
  }

  const flaggedTableHtml = flaggedRows.length
    ? `<div class="card"><div class="card-title">⚠️ Hồ sơ đang có cảnh báo (${flaggedRows.length})</div>
      <div class="card-sub">Bấm vào một dòng để xem ngay các con số của cảnh báo đó — không cần mở hồ sơ</div>
      ${flaggedProjects.length > 1 ? `<div style="margin-bottom:10px"><select class="btn btn-secondary" id="flagProjFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">
        <option value="ALL">Tất cả dự án (${flaggedRows.length})</option>
        ${flaggedProjects.map((code) => `<option value="${esc(code)}">${esc(code)} (${flaggedRows.filter((r) => r.projectCode === code).length})</option>`).join('')}
      </select></div>` : ''}
      <div style="overflow-x:auto"><table><thead><tr><th>Dự án</th><th>Nhà cung cấp</th><th>Loại</th><th>Số hồ sơ</th><th>Lý do</th></tr></thead><tbody>
      ${flaggedRows
        .map(
          (r) => `<tr class="click" data-fi="${r.idx}" data-proj="${esc(r.projectCode)}" style="cursor:pointer">
            <td><span class="code-chip" title="${esc(r.projectName)}">${esc(r.projectCode)}</span></td>
            <td>${esc(r.partner)}</td>
            <td>${r.typeLabel}</td>
            <td class="mono">${esc(r.docNumber)}</td>
            <td><span class="badge progress">${esc(r.reason)}</span> <span class="flag-caret" style="color:var(--gray4);font-size:11px">▾</span></td>
          </tr>${flagDetailHtml(r)}`,
        )
        .join('')}
      </tbody></table></div></div>`
    : '';

  // Danh sách trễ hạn toàn công ty (chỉ QLCP&HĐ/PTGD/TGD/Admin mới thấy) — Bước 1-2
  // hạn 2 ngày, Bước 3-4 hạn 1 ngày, khớp đúng quy tắc SLA đang dùng ở từng hồ sơ.
  const overdueAssignments = (overdueRaw || []).filter((a) => {
    const slaHours = a.step_no <= 2 ? 48 : 24;
    return a.created_at && (Date.now() - new Date(a.created_at).getTime()) / 3600000 > slaHours;
  });
  const overdueIdsByType = { contract: [], bill: [], totrinh: [] };
  overdueAssignments.forEach((a) => overdueIdsByType[a.document_type]?.push(a.document_id));
  const [{ data: odContracts }, { data: odBills }, { data: odTotrinh }] = overdueAssignments.length
    ? await Promise.all([
        overdueIdsByType.contract.length ? supabase.from('contracts').select('id, doc_number').in('id', overdueIdsByType.contract) : { data: [] },
        overdueIdsByType.bill.length ? supabase.from('bills').select('id, doc_number').in('id', overdueIdsByType.bill) : { data: [] },
        overdueIdsByType.totrinh.length ? supabase.from('to_trinh_chu_truong').select('id, doc_number').in('id', overdueIdsByType.totrinh) : { data: [] },
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const docNumMap = Object.fromEntries([...(odContracts || []), ...(odBills || []), ...(odTotrinh || [])].map((d) => [d.id, d.doc_number]));
  const typeLabel = { contract: 'Hợp đồng', bill: 'Bill', totrinh: 'Tờ trình' };
  const overdueRows = overdueAssignments.map((a) => ({
    label: typeLabel[a.document_type],
    docNumber: docNumMap[a.document_id] || '—',
    step: a.step_no,
    name: a.users?.full_name || '—',
    days: Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000),
  }));

  container.innerHTML = myRolesHtml + `
    ${overdueRows.length ? `
    <div class="card"><div class="card-title">⏰ Hồ sơ đang trễ hạn duyệt (toàn công ty)</div>
      <table><thead><tr><th>Loại</th><th>Số hồ sơ</th><th>Bước</th><th>Người đang chờ</th><th>Trễ</th></tr></thead><tbody>
      ${overdueRows.map((o) => `<tr><td>${o.label}</td><td class="mono">${o.docNumber}</td><td>Bước ${o.step}</td><td>${o.name}</td><td style="color:var(--red);font-weight:700">${o.days} ngày</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${budgetRowsFiltered && budgetRowsFiltered.length ? `
    <div class="card"><div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
      <div><div class="card-sub" style="margin:0">Ngân sách phân bổ</div><div class="stat-num">${tyi(totBudget)}</div></div>
      <div><div class="card-sub" style="margin:0">Cam kết (Hợp đồng)</div><div class="stat-num" style="color:var(--blue)">${tyi(totCommit)}</div><div class="stat-delta">${totBudget ? (totCommit / totBudget * 100).toFixed(0) : 0}% ngân sách</div></div>
      <div><div class="card-sub" style="margin:0">Thực chi (Bill đã duyệt)</div><div class="stat-num teal">${tyi(totActual)}</div><div class="stat-delta">${totCommit ? (totActual / totCommit * 100).toFixed(0) : 0}% cam kết</div></div>
    </div></div>

    <div class="card"><div class="card-title">Giá trị hợp đồng CĐT so với Ngân sách phân bổ</div>
      <div class="card-sub">Ngân sách phân bổ là giá trị HĐ CĐT sau khi QLCP&HĐ đã bóc tách sẵn phần lợi nhuận</div>
      <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="card-sub" style="margin:0">Giá trị HĐ CĐT</div><div class="stat-num">${tyi(totRevenue)}</div></div>
        <div><div class="card-sub" style="margin:0">Ngân sách phân bổ</div><div class="stat-num">${tyi(totBudget)}</div></div>
        <div><div class="card-sub" style="margin:0">Lợi nhuận đã bóc tách</div><div class="stat-num" style="color:${delta >= 0 ? 'var(--green)' : 'var(--red)'}">${delta >= 0 ? '+' : ''}${tyi(delta)}</div></div>
      </div></div>` : isDeptLimited ? '' : `<div class="empty-note">Chưa có phiên bản ngân sách nào${isSiteLimited ? ' cho (các) dự án bạn phụ trách' : ''}.</div>`}

    ${flaggedTableHtml}

    <div class="card"><div class="card-title">Danh sách đơn vị đã ký hợp đồng${isDeptLimited ? ` — ${myDept}` : ''}</div>
      <div class="card-sub">Giá trị hợp đồng so với giá trị lũy kế đã bill${isDeptLimited ? ' — chỉ hồ sơ do phòng bạn trình' : ''}</div>
      <table><thead><tr><th>Đối tác</th><th>Số hợp đồng</th><th>Giá trị HĐ</th><th>GT lũy kế bill</th><th>Còn lại</th></tr></thead><tbody>
      ${unitRows.length ? unitRows.map((u) => `<tr><td>${u.partner}</td><td class="mono">${u.docNumber}</td><td class="mono">${fmt(u.value)}</td>
      <td class="mono">${fmt(u.lũyKe)}</td><td class="mono" style="font-weight:700;color:${u.over ? 'var(--red)' : 'var(--green)'}">${fmt(u.left)}${u.over ? ' ⚠️' : ''}</td></tr>`).join('') :
      `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có hợp đồng nào</td></tr>`}
      </tbody></table></div>
  `;

  wireFlaggedTable(container, user);
}

// ============================================================
// Gắn sự kiện cho bảng cảnh báo: bấm dòng = bung/thu chi tiết, nút riêng để mở
// hồ sơ đầy đủ. Module hồ sơ được nạp bằng import động ngay lúc bấm — tránh
// nạp vòng (hopdong.js/bill.js cũng có thể tham chiếu ngược) và tránh làm hỏng
// cả trang Tổng quan nếu 1 module lỗi.
// ============================================================
function wireFlaggedTable(container, user) {
  container.querySelectorAll('tr[data-fi]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const detail = container.querySelector(`#flag-detail-${tr.dataset.fi}`);
      if (!detail) return;
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      const caret = tr.querySelector('.flag-caret');
      if (caret) caret.textContent = open ? '▾' : '▴';
    });
  });

  container.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // không để cú bấm này làm thu lại dòng chi tiết
      const type = btn.dataset.open;
      const id = btn.dataset.openId;
      try {
        const mod = await import(type === 'contract' ? './hopdong.js' : './bill.js');
        if (typeof mod.openDetail !== 'function') return toast('Không mở được hồ sơ từ đây — hãy vào tab tương ứng.', 'error');
        mod.openDetail(id, user, () => render(container, user));
      } catch (err) {
        toast('Không mở được hồ sơ: ' + (err?.message || err), 'error');
      }
    });
  });

  const projFilter = container.querySelector('#flagProjFilter');
  if (projFilter) {
    projFilter.addEventListener('change', () => {
      const v = projFilter.value;
      container.querySelectorAll('tr[data-fi]').forEach((tr) => {
        const show = v === 'ALL' || tr.dataset.proj === v;
        tr.style.display = show ? '' : 'none';
        const detail = container.querySelector(`#flag-detail-${tr.dataset.fi}`);
        if (detail && !show) detail.style.display = 'none'; // ẩn dòng cha thì thu luôn chi tiết
        const caret = tr.querySelector('.flag-caret');
        if (caret && !show) caret.textContent = '▾';
      });
    });
  }
}
