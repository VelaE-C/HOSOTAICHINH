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

  const [{ data: projects }, { data: budgetRows }, { data: revenueRows }, { data: flagged }, { data: contracts }, { data: bills }, { data: myAssignments }, { data: overdueRaw }, { data: myDeptRoles }, { data: receipts }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
      supabase.from('v_budget_summary').select('*'),
      supabase.from('revenue_contracts').select('project_id, investor, value'),
      supabase.from('v_flagged_documents').select('*'),
      // Bổ sung status / parent_contract_id / projects(code,name) để bảng cảnh báo
      // tra được Dự án, Nhà cung cấp và cộng dồn PLHĐ mà không phải gọi thêm query
      supabase.from('contracts').select('id, doc_number, value, value_adjustment, status, parent_contract_id, project_id, origin_department, partners(name), projects(code, name)'),
      // Bổ sung id / doc_number để đối chiếu đúng dòng cảnh báo là bill nào
      // Bổ sung val_e..val_h + vat_rate + period_no để tính ĐÚNG chi phí dự án:
      // chi phí = I (tổng thanh toán gồm tạm ứng) của bill kỳ MỚI NHẤT mỗi hợp đồng,
      // quy về trước thuế — khớp đúng cột "Đã TT" của BCTC.
      supabase.from('bills').select('id, doc_number, contract_id, project_id, partner_id, period_no, status, val_d, val_e, val_f, val_g, val_h, vat_rate'),
      supabase.from('project_role_assignments').select('role_type, project_id, projects(code)').eq('user_id', user.id).is('effective_to', null),
      isTopLevel
        ? supabase.from('approval_assignments').select('document_type, document_id, step_no, created_at, users(full_name)').eq('status', 'pending')
        : Promise.resolve({ data: [] }),
      supabase.from('user_roles').select('department').eq('user_id', user.id).eq('role_type', 'TruongPhongChucNang'),
      supabase.from('owner_receipts').select('project_id, claim_no, amount_before_vat, paid_date'),
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
  // contractsFiltered đã bỏ cùng bảng "Danh sách đơn vị đã ký hợp đồng" — không còn nơi nào dùng

  // Tổng hợp ngân sách 3 lớp — giờ ai cũng xem được (đã mở RLS), lọc theo dự án nếu cần
  const totBudget = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.allocated_value || 0), 0);
  const totCommit = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.committed || 0), 0);
  const totActual = (budgetRowsFiltered || []).reduce((s, r) => s + Number(r.actual_spend || 0), 0);
  const totRevenue = (revenueRowsFiltered || []).reduce((s, r) => s + Number(r.value || 0), 0);
  const delta = totRevenue - totBudget;

  // Lũy kế đã bill theo từng hợp đồng — bảng cảnh báo Case 1 dùng để tính phần vượt
  const lũyKeByContract = {};
  (bills || []).forEach((b) => {
    if (!b.contract_id) return;
    lũyKeByContract[b.contract_id] = Math.max(lũyKeByContract[b.contract_id] || 0, Number(b.val_d || 0));
  });
  // Bảng "Danh sách đơn vị đã ký hợp đồng" ĐÃ GỠ theo yêu cầu 25/09/2026 — thông tin
  // đó vẫn tra được đầy đủ ở tab Hợp đồng. Biến lũyKeByContract bên trên GIỮ LẠI vì
  // bảng cảnh báo Case 1 vẫn dùng để tính phần vượt.

  // ============================================================
  // BẢNG TỔNG THEO DỰ ÁN — Doanh thu HĐ · Thực thu · Chi phí · Dòng tiền ròng
  //
  // CỐ Ý đặt tên cột "Dòng tiền ròng" chứ không phải "Chênh lệch": đây là
  // TIỀN VÀO trừ TIỀN RA, KHÔNG phải lợi nhuận. Lợi nhuận = sản lượng đã làm trừ
  // chi phí phát sinh (Hàng C của BCTC). Dự án lãi vẫn có thể âm dòng tiền vì CĐT
  // giữ lại và trả chậm — đặt tên nhập nhằng là sớm muộn có người đọc nhầm.
  //
  // CHI PHÍ DỰ ÁN: lấy I (= D+E+F+G+H, tổng thanh toán gồm tạm ứng) của bill kỳ
  // MỚI NHẤT trong mỗi nhóm, rồi quy về TRƯỚC THUẾ. val_d vốn đã gồm VAT nên chia
  // cho (1+VAT). Gom nhóm theo hợp đồng; bill chưa gắn hợp đồng thì gom theo cặp
  // Dự án+Đối tác để không bỏ sót (BCTC chỉ đếm dòng có hợp đồng — đây là lý do
  // con số ở 2 màn hình có thể lệch nhau, và lệch đúng phần bill chưa gắn HĐ).
  // ============================================================
  const validBills = (bills || []).filter((b) => !['draft', 'cancelled', 'rejected'].includes(b.status));
  const latestBillByGroup = {};
  validBills.forEach((b) => {
    const key = b.contract_id || `np:${b.project_id}|${b.partner_id}`;
    const cur = latestBillByGroup[key];
    if (!cur || Number(b.period_no || 0) > Number(cur.period_no || 0)) latestBillByGroup[key] = b;
  });
  const costByProject = {};
  Object.values(latestBillByGroup).forEach((b) => {
    const projectId = b.project_id || contractById2(b.contract_id)?.project_id;
    if (!projectId) return;
    const I = Number(b.val_d || 0) + Number(b.val_e || 0) + Number(b.val_f || 0) + Number(b.val_g || 0) + Number(b.val_h || 0);
    const div = 1 + (Number(b.vat_rate ?? 8) || 0) / 100;
    costByProject[projectId] = (costByProject[projectId] || 0) + Math.round(I / (div || 1));
  });
  function contractById2(id) {
    if (!id) return null;
    return (contracts || []).find((c) => c.id === id) || null;
  }

  const revenueByProject = {};
  (revenueRows || []).forEach((r) => (revenueByProject[r.project_id] = Number(r.value || 0)));

  const receiptByProject = {};
  (receipts || []).forEach((r) => (receiptByProject[r.project_id] = (receiptByProject[r.project_id] || 0) + Number(r.amount_before_vat || 0)));

  // CHT/GĐDA/QS: chỉ dự án mình phụ trách. Vai trò cấp công ty: xem hết.
  const summaryProjects = (projects || []).filter((p) => (isSiteLimited ? myProjectIds.has(p.id) : true));

  const summaryRows = summaryProjects.map((p) => {
    const doanhThu = revenueByProject[p.id] ?? null;   // null = chưa nhập HĐ đầu ra
    const thucThu = receiptByProject[p.id] || 0;
    const chiPhi = costByProject[p.id] || 0;
    const rong = thucThu - chiPhi;
    // Ghi chú tự sinh — nói đúng điều đáng chú ý nhất của dòng đó, không tô hồng
    let danhGia = '';
    if (doanhThu == null) danhGia = '⚠️ Chưa nhập HĐ đầu ra — không đánh giá được';
    else if (!thucThu && !chiPhi) danhGia = 'Chưa phát sinh thu/chi';
    else if (!thucThu) danhGia = '⚠️ Đã chi nhưng CĐT chưa trả đồng nào';
    else if (rong < 0) danhGia = `Âm dòng tiền — đang ứng vốn ${fmt(-rong)} ₫`;
    else danhGia = `Dương dòng tiền ${fmt(rong)} ₫`;
    const thuPct = doanhThu ? (thucThu / doanhThu) * 100 : null;
    return { p, doanhThu, thucThu, chiPhi, rong, danhGia, thuPct };
  });

  const tDoanhThu = summaryRows.reduce((s2, r) => s2 + (r.doanhThu || 0), 0);
  const tThucThu = summaryRows.reduce((s2, r) => s2 + r.thucThu, 0);
  const tChiPhi = summaryRows.reduce((s2, r) => s2 + r.chiPhi, 0);
  const tRong = tThucThu - tChiPhi;

  const summaryTableHtml = `
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
      <div style="padding:14px 16px 0">
        <div class="card-title" style="margin:0">Dòng tiền theo dự án</div>
        <div class="card-sub">Mọi con số TRƯỚC THUẾ. <b>Dòng tiền ròng = Thực thu − Chi phí</b> — đây là tiền vào trừ tiền ra, <b>không phải lợi nhuận</b>${isSiteLimited ? ' · chỉ hiện dự án bạn phụ trách' : ''}</div>
      </div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Dự án</th>
        <th style="text-align:right">Doanh thu HĐ</th>
        <th style="text-align:right">Thực thu từ CĐT</th>
        <th style="text-align:right">Chi phí dự án</th>
        <th style="text-align:right">Dòng tiền ròng</th>
        <th>Ghi chú</th>
      </tr></thead><tbody>
      ${summaryRows.length
        ? summaryRows
            .map(
              (r) => `<tr>
          <td><span class="code-chip" title="${esc(r.p.name)}">${esc(r.p.code)}</span></td>
          <td class="mono" style="text-align:right">${r.doanhThu == null ? '<span style="color:var(--gray3)">—</span>' : fmt(r.doanhThu)}</td>
          <td class="mono" style="text-align:right">${fmt(r.thucThu)}${r.thuPct != null ? `<div style="font-size:10.5px;color:var(--gray4);font-weight:400">${r.thuPct.toFixed(0)}% HĐ</div>` : ''}</td>
          <td class="mono" style="text-align:right">${fmt(r.chiPhi)}</td>
          <td class="mono" style="text-align:right;font-weight:700;color:${r.rong < 0 ? 'var(--red)' : 'var(--green)'}">${r.rong >= 0 ? '+' : ''}${fmt(r.rong)}</td>
          <td style="font-size:12px;color:${r.danhGia.startsWith('⚠️') || r.rong < 0 ? 'var(--amber)' : 'var(--gray6)'}">${esc(r.danhGia)}</td>
        </tr>`,
            )
            .join('')
        : `<tr><td colspan="6" style="text-align:center;color:var(--gray4);padding:20px">Không có dự án nào trong phạm vi của bạn</td></tr>`}
      </tbody>
      ${summaryRows.length ? `<tfoot><tr style="background:var(--gray1);font-weight:700">
        <td>TỔNG</td>
        <td class="mono" style="text-align:right">${fmt(tDoanhThu)}</td>
        <td class="mono" style="text-align:right">${fmt(tThucThu)}</td>
        <td class="mono" style="text-align:right">${fmt(tChiPhi)}</td>
        <td class="mono" style="text-align:right;color:${tRong < 0 ? 'var(--red)' : 'var(--green)'}">${tRong >= 0 ? '+' : ''}${fmt(tRong)}</td>
        <td></td>
      </tr></tfoot>` : ''}
      </table></div>
    </div>`;

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

  // PLHĐ con của từng hợp đồng gốc, TÁCH RIÊNG đã duyệt / đang duyệt.
  // Chỉ PLHĐ đã duyệt (status='active') mới được cộng vào giá trị hợp đồng —
  // PLHĐ còn đang duyệt thì về pháp lý chưa có hiệu lực, cộng vào sẽ làm cảnh báo
  // tự tắt oan chỉ vì ai đó vừa bấm lưu nháp. PLHĐ đang duyệt hiện thành một dòng
  // riêng, để biết cảnh báo sắp được gỡ bằng cách nào.
  const plhdByParent = {};
  (contracts || []).forEach((c) => {
    if (!c.parent_contract_id) return;
    const g = (plhdByParent[c.parent_contract_id] = plhdByParent[c.parent_contract_id] || { active: [], pending: [] });
    if (c.status === 'active') g.active.push(c);
    else if (c.status === 'pending' || c.status === 'draft') g.pending.push(c);
  });
  const plhdGroup = (contractId) => plhdByParent[contractId] || { active: [], pending: [] };
  const sumVal = (arr) => (arr || []).reduce((s, k) => s + Number(k.value || 0), 0);
  // Giá trị hợp đồng ĐANG CÓ HIỆU LỰC = HĐ gốc + điều chỉnh tay + các PLHĐ đã duyệt xong.
  // Công thức này PHẢI khớp đúng hàm fn_contract_ceiling() bên database — nếu sau này
  // sửa một bên thì phải sửa cả bên kia, nếu không số trên màn hình sẽ khác số dùng để
  // gắn cảnh báo, và không ai biết tin bên nào.
  const effectiveValue = (c) => (c ? Number(c.value || 0) + Number(c.value_adjustment || 0) + sumVal(plhdGroup(c.id).active) : 0);

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
    const pct = (over, base) => (base > 0 ? ` <span style="color:var(--gray5)">(${((over / base) * 100).toFixed(0)}% giá trị HĐ)</span>` : '');
    let body = '';
    let hint = '';

    // ---- Case 2: vượt ngân sách phân bổ (so ngân sách dự án, không liên quan PLHĐ) ----
    if (/ngân sách/i.test(r.reason)) {
      const rows = (budgetRows || []).filter((b) => b.project_id === r.contract?.project_id);
      const alloc = rows.reduce((s, b) => s + Number(b.allocated_value || 0), 0);
      const commit = rows.reduce((s, b) => s + Number(b.committed || 0), 0);
      body =
        kv('Dự án', esc(r.projectName || r.projectCode)) +
        kv('Ngân sách phân bổ', fmt(alloc) + ' ₫') +
        kv('Đã cam kết (hợp đồng)', fmt(commit) + ' ₫', 'font-weight:700') +
        kv('Phần vượt ngân sách', commit > alloc ? fmt(commit - alloc) + ' ₫' + pct(commit - alloc, alloc) : '—', `font-weight:700;color:${commit > alloc ? 'var(--red)' : 'var(--green)'}`) +
        kv('Giá trị hợp đồng này', fmt(r.contract?.value) + ' ₫');
      hint = 'Hướng xử lý: điều chỉnh ngân sách phân bổ của dự án, hoặc rà lại giá trị hợp đồng trước khi duyệt.';
      return flagDetailWrap(r, body, hint);
    }

    // ---- Case 1: lấy hợp đồng làm gốc, phân biệt PLHĐ đã duyệt / đang duyệt ----
    const c = r.contract;
    if (!c) {
      return flagDetailWrap(r, kv('Chi tiết', 'Không tra được hồ sơ gốc — có thể ngoài phạm vi bạn được xem.'), '');
    }
    const g = plhdGroup(c.id);
    const eff = effectiveValue(c); // HĐ gốc + PLHĐ ĐÃ DUYỆT
    const pendingSum = sumVal(g.pending); // PLHĐ đang duyệt — chưa có hiệu lực
    // Hợp đồng: so với lũy kế cao nhất của mọi bill. Bill: so với chính đợt đó.
    const lk = r.docType === 'contract' ? lũyKeByContract[c.id] || 0 : Number(r.bill?.val_d || 0);
    const over = lk - eff;

    body =
      (r.docType === 'bill' ? kv('Hợp đồng liên kết', esc(c.doc_number)) : '') +
      kv('Giá trị HĐ gốc', fmt(c.value) + ' ₫') +
      kv(`PLHĐ đã duyệt (${g.active.length})`, g.active.length ? '+' + fmt(sumVal(g.active)) + ' ₫' : '<span style="color:var(--gray4)">Chưa có PLHĐ nào được duyệt</span>') +
      kv('Giá trị HĐ đang có hiệu lực', fmt(eff) + ' ₫', 'font-weight:700') +
      kv(r.docType === 'contract' ? 'Lũy kế đã bill (cao nhất)' : 'Lũy kế đến đợt này (D)', fmt(lk) + ' ₫') +
      kv('Phần vượt', over > 0 ? fmt(over) + ' ₫' + pct(over, eff) : '—', `font-weight:700;color:${over > 0 ? 'var(--red)' : 'var(--green)'}`) +
      (g.pending.length ? kv(`PLHĐ đang duyệt (${g.pending.length})`, fmt(pendingSum) + ' ₫ <span style="color:var(--gray5)">— chưa tính vào giá trị trên</span>', 'color:var(--amber);font-weight:600') : '');

    if (over <= 0) {
      hint = '✅ Hiện không còn vượt — có thể PLHĐ vừa được duyệt xong. Tải lại trang (Ctrl+Shift+R) là cảnh báo sẽ biến mất.';
    } else if (g.pending.length && pendingSum >= over) {
      const du = pendingSum - over;
      hint = `⏳ PLHĐ <b>${esc(g.pending.map((k) => k.doc_number).join(', '))}</b> đang chờ duyệt. Duyệt xong sẽ bù đủ phần vượt${du > 0 ? ` và còn dư <b>${fmt(du)} ₫</b>` : ''} → cảnh báo tự hết. <b>Việc cần làm: đẩy PLHĐ này qua nốt luồng duyệt.</b>`;
    } else if (g.pending.length) {
      hint = `⚠️ PLHĐ đang duyệt chỉ bù được ${fmt(pendingSum)} ₫, <b>vẫn thiếu ${fmt(over - pendingSum)} ₫</b>. Cần tạo thêm PLHĐ hoặc rà lại giá trị bill đã trình.`;
    } else {
      hint = `⚠️ Chưa có PLHĐ nào đang chạy. Cần tạo PLHĐ bổ sung tối thiểu <b>${fmt(over)} ₫</b>, hoặc rà lại giá trị bill đã trình.`;
    }
    return flagDetailWrap(r, body, hint);
  }

  function flagDetailWrap(r, body, hint) {
    return `<tr class="flag-detail" id="flag-detail-${r.idx}" style="display:none">
      <td colspan="5" style="background:var(--gray1,#F5F6F8);padding:14px 18px">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 18px;font-size:13px;max-width:620px">${body}</div>
        ${hint ? `<div style="font-size:12.5px;color:var(--gray5);margin-top:11px;max-width:620px;line-height:1.5">${hint}</div>` : ''}
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
            <td><span class="badge progress">${esc(r.reason)}</span> <span class="flag-caret" style="color:var(--gray4);font-size:10px;margin-left:4px">▼</span></td>
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

  container.innerHTML = myRolesHtml + summaryTableHtml + `
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
      if (caret) caret.textContent = open ? '▼' : '▲';
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
        if (caret && !show) caret.textContent = '▼';
      });
    });
  }
}
