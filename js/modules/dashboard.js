// ============================================================
// dashboard.js — Tổng quan: Ngân sách/Cam kết/Thực chi, HĐ CĐT vs ngân sách,
// danh sách hồ sơ vượt (Case 1/2), danh sách đơn vị đã ký hợp đồng.
// Toàn bộ dữ liệu lấy thật từ Supabase — RLS tự lọc đúng phạm vi theo vai trò
// đang đăng nhập, module này không cần tự kiểm tra quyền.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, tyi, budgetColor } from '../core/utils.js';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải dữ liệu…</div>`;

  const isTopLevel = (user.roles || []).some((r) => ['QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'].includes(r));

  const [{ data: projects }, { data: budgetRows }, { data: revenueRows }, { data: flagged }, { data: contracts }, { data: bills }, { data: myAssignments }, { data: overdueRaw }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
      supabase.from('v_budget_summary').select('*'),
      supabase.from('revenue_contracts').select('project_id, investor, value'),
      supabase.from('v_flagged_documents').select('*'),
      supabase.from('contracts').select('id, doc_number, value, project_id, partners(name)'),
      supabase.from('bills').select('contract_id, val_d'),
      supabase.from('project_role_assignments').select('role_type, project_id, projects(code)').eq('user_id', user.id).is('effective_to', null),
      isTopLevel
        ? supabase.from('approval_assignments').select('document_type, document_id, step_no, created_at, users(full_name)').eq('status', 'pending')
        : Promise.resolve({ data: [] }),
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

  const budgetRowsFiltered = isSiteLimited ? (budgetRows || []).filter((r) => myProjectIds.has(r.project_id)) : budgetRows;
  const revenueRowsFiltered = isSiteLimited ? (revenueRows || []).filter((r) => myProjectIds.has(r.project_id)) : revenueRows;
  const contractsFiltered = isSiteLimited ? (contracts || []).filter((c) => myProjectIds.has(c.project_id)) : contracts;

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
      </div></div>` : `<div class="empty-note">Chưa có phiên bản ngân sách nào${isSiteLimited ? ' cho (các) dự án bạn phụ trách' : ''}.</div>`}

    ${flagged && flagged.length ? `
    <div class="card"><div class="card-title">⚠️ Hồ sơ đang có cảnh báo</div>
      <table><thead><tr><th>Loại</th><th>Số hồ sơ</th><th>Lý do</th></tr></thead><tbody>
      ${flagged.map((f) => `<tr><td>${f.doc_type === 'contract' ? 'Hợp đồng' : 'Bill'}</td><td class="mono">${f.doc_number}</td><td><span class="badge progress">${f.flag_reason}</span></td></tr>`).join('')}
      </tbody></table></div>` : ''}

    <div class="card"><div class="card-title">Danh sách đơn vị đã ký hợp đồng</div>
      <div class="card-sub">Giá trị hợp đồng so với giá trị lũy kế đã bill</div>
      <table><thead><tr><th>Đối tác</th><th>Số hợp đồng</th><th>Giá trị HĐ</th><th>GT lũy kế bill</th><th>Còn lại</th></tr></thead><tbody>
      ${unitRows.length ? unitRows.map((u) => `<tr><td>${u.partner}</td><td class="mono">${u.docNumber}</td><td class="mono">${fmt(u.value)}</td>
      <td class="mono">${fmt(u.lũyKe)}</td><td class="mono" style="font-weight:700;color:${u.over ? 'var(--red)' : 'var(--green)'}">${fmt(u.left)}${u.over ? ' ⚠️' : ''}</td></tr>`).join('') :
      `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có hợp đồng nào</td></tr>`}
      </tbody></table></div>
  `;
}
