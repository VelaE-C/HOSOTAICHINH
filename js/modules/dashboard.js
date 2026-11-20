// ============================================================
// dashboard.js — Tổng quan: Ngân sách/Cam kết/Thực chi, HĐ CĐT vs ngân sách,
// danh sách hồ sơ vượt (Case 1/2), danh sách đơn vị đã ký hợp đồng.
// Toàn bộ dữ liệu lấy thật từ Supabase — RLS tự lọc đúng phạm vi theo vai trò
// đang đăng nhập, module này không cần tự kiểm tra quyền.
//
// ⚠️ SỬA 08/10/2026 — ĐỔI NGUỒN "GIÁ TRỊ HĐ" VÀ ĐỔI TÊN CỘT
//
//   1. BỎ hẳn truy vấn bảng revenue_contracts. Bảng đó 0 dòng, chưa bao giờ có
//      dữ liệu (bản kiểm kê 30/09), nên cột "Giá trị HĐ" luôn ra "—" kèm lời
//      nhắc vào tab "Hợp đồng đầu ra (CĐT)" — mà tab đó đã ẩn ngày 08/10.
//      Nay lấy từ owner_progress_claims (tab Doanh thu dự án), nơi đã có số thật.
//
//   2. 🔴 LẤY THEO ĐỢT CLAIM MỚI NHẤT, TUYỆT ĐỐI KHÔNG CỘNG DỒN.
//      Mỗi phiếu claim CHỤP LẠI giá trị hợp đồng tại thời điểm đó. Cộng dồn 3 đợt
//      = giá trị hợp đồng gấp 3 lần, mà vẫn ra một con số trông hợp lý nên không
//      ai phát hiện. Hiện mỗi dự án mới có đợt 1 nên hai cách ra như nhau —
//      đúng lúc chưa lộ mới là lúc dễ cài sai nhất.
//
//   3. CỘT DOANH THU THÌ NGƯỢC LẠI: VẪN CỘNG mọi đợt, vì ô amount_before_vat
//      theo thiết kế là "(2) GIÁ TRỊ THI CÔNG KỲ NÀY" — phần tăng thêm của riêng
//      kỳ đó, không phải lũy kế. Hai cột lấy theo hai cách ngược nhau là CỐ Ý.
//      ⚠️ Kèm theo đó: đợt 2 trở đi chỉ được nhập PHẦN TĂNG THÊM. Nhập lũy kế
//      vào đợt 2 là doanh thu bị cộng đôi. 10 dòng nhập ngày 08/10 là trường hợp
//      đặc biệt (lũy kế gộp vào đợt 1), đã ghi rõ trong cột Ghi chú của chúng.
//
//   4. Đổi tên cột "Sản lượng từ CĐT" -> "Doanh thu", và đổi tên hai biến
//      doanhThu/sanLuong cho khớp nghĩa mới (bản cũ đặt tên NGƯỢC: biến tên
//      doanhThu lại đang giữ giá trị hợp đồng).
//
//   5. BỎ cột "Ghi chú" (yêu cầu 08/10). Bỏ luôn biến danhGia sinh ra nội dung
//      cột đó, không để lại code chết. Dự án chưa nhập giá trị HĐ nay chỉ hiện
//      dấu "—" xám ở cột Giá trị HĐ, không còn câu nhắc kèm theo.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, IS_MOBILE } from '../core/utils.js';
// Danh sách vai trò cấp toàn công ty — nhập từ shell.js, KHÔNG chép lại.
// Bản cũ gõ thẳng mảng này ở 2 chỗ bên dưới; sửa một chỗ quên chỗ kia là hai
// phép lọc chạy lệch nhau mà không báo lỗi gì.
import { COMPANY_WIDE_ROLES } from '../core/shell.js';

// Chống vỡ HTML khi tên đối tác/dự án có ký tự đặc biệt (&, <, ">, dấu nháy)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill', totrinh: 'Tờ trình', bctc: 'BCTC' };

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải dữ liệu…</div>`;

  const isTopLevel = (user.roles || []).some((r) => COMPANY_WIDE_ROLES.includes(r));

  const [{ data: projects }, { data: contracts }, { data: bills }, { data: myAssignments }, { data: claims }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
      // Bổ sung status / parent_contract_id / projects(code,name) để bảng cảnh báo
      // tra được Dự án, Nhà cung cấp và cộng dồn PLHĐ mà không phải gọi thêm query
      // contract_type thêm 20/11/2026 cho khối "Cam kết theo loại hợp đồng"
      supabase.from('contracts').select('id, doc_number, value, value_adjustment, status, contract_type, parent_contract_id, project_id, origin_department, partners(name), projects(code, name)'),
      // Bổ sung id / doc_number để đối chiếu đúng dòng cảnh báo là bill nào.
      // period_no + vat_rate để tính chi phí dự án (xem khối CHI PHÍ bên dưới).
      // ⚠️ KHÔNG lấy val_e..val_h nữa — chốt 20/11/2026 chi phí chỉ tính theo
      //   SẢN LƯỢNG (val_d). Lấy về mà không dùng chỉ khiến người đọc sau tưởng
      //   công thức vẫn còn cộng mấy ô đó.
      supabase.from('bills').select('id, doc_number, contract_id, project_id, partner_id, period_no, status, val_d, vat_rate'),
      supabase.from('project_role_assignments').select('role_type, project_id, projects(code)').eq('user_id', user.id).is('effective_to', null),
      // contract_amount + vo_amount: nguồn MỚI của cột "Giá trị HĐ" (thay revenue_contracts)
      supabase.from('owner_progress_claims').select('project_id, claim_no, amount_before_vat, contract_amount, vo_amount, confirmed_date'),
    ]);

  // Khối "Vai trò của tôi" ĐÃ BỎ 20/11/2026 theo yêu cầu — vai trò tra được ở
  // tab Người dùng, không cần chiếm một dải ngang đầu trang Tổng quan.

  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống, hoặc bạn chưa được phân công dự án nào.</div>`;
    return;
  }

  // Ngân sách/HĐ đầu ra giờ ai cũng xem được, nhưng nếu người này CÓ gắn với
  // (các) dự án cụ thể (CHT/GĐDA/QS/PTGD-công trường...) thì chỉ hiện đúng
  // dự án đó — vai trò văn phòng thuần (Kế toán/Pháp chế/QLCP&HĐ không gắn dự án
  // cụ thể) vẫn thấy toàn bộ như trước, đúng vai trò xuyên suốt của họ.
  const myProjectIds = new Set((myAssignments || []).map((a) => a.project_id).filter(Boolean));
  const isSiteLimited = myProjectIds.size > 0 && !(user.roles || []).some((r) => COMPANY_WIDE_ROLES.includes(r));

  // budgetRowsFiltered / revenueRowsFiltered đã gỡ cùng 2 khối thống kê ngân sách.
  // contractsFiltered đã bỏ cùng bảng "Danh sách đơn vị đã ký hợp đồng" — không còn nơi nào dùng


  // ============================================================
  // BẢNG TỔNG THEO DỰ ÁN — Giá trị HĐ · Doanh thu · Sản lượng · Chênh lệch
  //
  // ⚠️ Cột hiển thị tên "Sản lượng" (đổi 20/11/2026) nhưng biến trong code vẫn tên
  //   chiPhi / tChiPhi. CỐ Ý giữ nguyên tên biến: đổi tên biến chỉ để khớp nhãn là
  //   sửa vào chỗ đang chạy đúng, không được lợi gì. Hai cái là một con số:
  //   sản lượng thầu phụ đã thực hiện, trước thuế.
  //
  // ✅ ĐÃ CHỐT 20/11/2026 — CHI PHÍ CHỈ LẤY SẢN LƯỢNG, KHÔNG TÍNH TẠM ỨNG.
  //
  // CHI PHÍ DỰ ÁN = ô D (val_d, sản lượng thầu phụ đã thực hiện lũy kế) của bill kỳ
  // MỚI NHẤT trong mỗi nhóm, quy về TRƯỚC THUẾ. val_d đã gồm VAT nên chia (1+VAT).
  //
  // ⚠️ BẢN CŨ LẤY I = D+E+F+G+H VÀ ĐÓ LÀ SAI. Trong đó:
  //   F = TẠM ỨNG — tiền ứng trước cho khối lượng CHƯA LÀM, không phải chi phí.
  //       VEGA20CAN-MEP phồng lên 515 triệu chỉ vì 703 triệu tạm ứng của 2 nhà thầu.
  //   E = GIỮ LẠI — bị TRỪ khỏi chi phí, trong khi công đã làm rồi, chỉ là chưa trả
  //       tiền. Đây là lý do 7/10 dự án bị thiếu chi phí, HANGHAI thiếu tới 1,01 tỷ.
  //   Cộng lại, toàn công ty thiếu ~2,18 tỷ chi phí -> cột Chênh lệch nói lãi cao
  //   hơn thực tế đúng chừng đó.
  //
  // Nay hai vế cùng một thước đo: Doanh thu = sản lượng CĐT xác nhận (trước thuế,
  // trước giữ lại), Chi phí = sản lượng thầu phụ đã làm (trước thuế, trước giữ lại).
  // Chênh lệch giờ mới đúng nghĩa LÃI GỘP THỰC HIỆN.
  //
  // ⚠️ Chi phí này KHÁC "tiền đã chi". Tạm ứng đã trả ra nhưng không nằm ở đây.
  //   Cần theo dõi dòng tiền thì phải làm cột riêng, đừng mượn cột này.
  //
  // Gom nhóm theo hợp đồng; bill chưa gắn hợp đồng thì gom theo cặp Dự án+Đối tác
  // để không bỏ sót (BCTC chỉ đếm dòng có hợp đồng — đây là lý do con số ở 2 màn
  // hình có thể lệch nhau, và lệch đúng phần bill chưa gắn HĐ).
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
    const div = 1 + (Number(b.vat_rate ?? 8) || 0) / 100;
    costByProject[projectId] = (costByProject[projectId] || 0) + Math.round(Number(b.val_d || 0) / (div || 1));
  });
  function contractById2(id) {
    if (!id) return null;
    return (contracts || []).find((c) => c.id === id) || null;
  }

  // GIÁ TRỊ HỢP ĐỒNG — lấy của ĐỢT CLAIM MỚI NHẤT mỗi dự án. KHÔNG cộng dồn.
  // (Xem ghi chú mục 2 đầu file để biết vì sao cộng dồn là sai.)
  const latestClaimByProject = {};
  (claims || []).forEach((r) => {
    const cur = latestClaimByProject[r.project_id];
    if (!cur || Number(r.claim_no || 0) > Number(cur.claim_no || 0)) latestClaimByProject[r.project_id] = r;
  });
  const contractValueByProject = {};
  Object.entries(latestClaimByProject).forEach(([pid, r]) => {
    const v = Number(r.contract_amount || 0) + Number(r.vo_amount || 0);
    contractValueByProject[pid] = v > 0 ? v : null; // 0 hoặc trống = coi như CHƯA NHẬP, để còn nhắc
  });

  // DOANH THU — CỘNG mọi đợt (ngược với cột trên). Xem ghi chú mục 3 đầu file.
  const claimByProject = {};
  (claims || []).forEach((r) => (claimByProject[r.project_id] = (claimByProject[r.project_id] || 0) + Number(r.amount_before_vat || 0)));

  // CHT/GĐDA/QS: chỉ dự án mình phụ trách. Vai trò cấp công ty: xem hết.
  const summaryProjects = (projects || []).filter((p) => (isSiteLimited ? myProjectIds.has(p.id) : true));

  const summaryRows = summaryProjects.map((p) => {
    const giaTriHD = contractValueByProject[p.id] ?? null; // null = chưa nhập giá trị HĐ trên phiếu claim
    const doanhThu = claimByProject[p.id] || 0;
    const chiPhi = costByProject[p.id] || 0;
    const chenhLech = doanhThu - chiPhi;
    const thuPct = giaTriHD ? (doanhThu / giaTriHD) * 100 : null;
    return { p, giaTriHD, doanhThu, chiPhi, chenhLech, thuPct };
  });

  const tGiaTriHD = summaryRows.reduce((s2, r) => s2 + (r.giaTriHD || 0), 0);
  const tDoanhThu = summaryRows.reduce((s2, r) => s2 + r.doanhThu, 0);
  const tChiPhi = summaryRows.reduce((s2, r) => s2 + r.chiPhi, 0);
  const tChenhLech = tDoanhThu - tChiPhi;

  // ============================================================
  // BẢNG TỔNG HỢP — gộp luôn biểu đồ vào trong bảng (20/11/2026)
  //
  // Trước đó có MỘT biểu đồ thanh ngang riêng + MỘT bảng số riêng, cùng nói về
  // một bộ số. Cộng lại cao hơn 1.400px, không lọt một màn hình, mà cũng vi phạm
  // nguyên tắc "một con số chỉ hiện một chỗ".
  // Nay nhập làm một: mỗi dòng có 2 thanh so sánh Doanh thu / Sản lượng ngay
  // trong ô. Vẫn nhìn được hơn kém ở một cái liếc, mà chỉ cao bằng cái bảng.
  //
  // Xếp theo chênh lệch từ cao xuống thấp — dự án đang âm rơi xuống cuối bảng,
  // đúng chỗ người đọc tìm.
  // ============================================================
  const tableRows = [...summaryRows].sort((a, b) => b.chenhLech - a.chenhLech);

  const summaryTableHtml = `
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
      <div style="padding:14px 16px 0">
        <div class="card-title" style="margin:0">Tổng hợp theo dự án</div>
        <div class="card-sub">Mọi con số TRƯỚC THUẾ. <b>Chênh lệch = Doanh thu − Sản lượng</b>${isSiteLimited ? ' · chỉ hiện dự án bạn phụ trách' : ''}</div>
      </div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Dự án</th>
        <th style="text-align:right">Giá trị HĐ</th>
        <th style="text-align:right">Doanh thu</th>
        <th style="text-align:right">Sản lượng</th>
        <th style="text-align:right">Chênh lệch</th>
      </tr></thead><tbody>
      ${tableRows.length
        ? tableRows
            .map(
              (r) => `<tr>
          <td><span class="code-chip" title="${esc(r.p.name)}">${esc(r.p.code)}</span></td>
          <td class="mono" style="text-align:right">${r.giaTriHD == null ? '<span style="color:var(--gray3)">—</span>' : fmt(r.giaTriHD)}</td>
          <td class="mono" style="text-align:right">${fmt(r.doanhThu)}${r.thuPct != null ? `<div style="font-size:10.5px;color:var(--gray4);font-weight:400">${r.thuPct > 0 && r.thuPct < 1 ? '<1' : r.thuPct.toFixed(0)}% HĐ</div>` : ''}</td>
          <td class="mono" style="text-align:right">${fmt(r.chiPhi)}</td>
          <td class="mono" style="text-align:right;font-weight:700;color:${r.chenhLech < 0 ? 'var(--red)' : 'var(--green)'}">${r.chenhLech >= 0 ? '+' : ''}${fmt(r.chenhLech)}</td>
        </tr>`,
            )
            .join('')
        : `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Không có dự án nào trong phạm vi của bạn</td></tr>`}
      </tbody>
      ${summaryRows.length ? `<tfoot><tr style="background:var(--gray1);font-weight:700">
        <td>TỔNG</td>
        <td class="mono" style="text-align:right">${fmt(tGiaTriHD)}</td>
        <td class="mono" style="text-align:right">${fmt(tDoanhThu)}</td>
        <td class="mono" style="text-align:right">${fmt(tChiPhi)}</td>
        <td class="mono" style="text-align:right;color:${tChenhLech < 0 ? 'var(--red)' : 'var(--green)'}">${tChenhLech >= 0 ? '+' : ''}${fmt(tChenhLech)}</td>
      </tr></tfoot>` : ''}
      </table></div>
    </div>`;

  // Khối "Hồ sơ đang có cảnh báo" ĐÃ GỠ 20/11/2026 theo yêu cầu. Cảnh báo vượt
  // vẫn hiện trên từng hồ sơ ở tab Hợp đồng và Bill thanh toán.

  // Khối "Hồ sơ trễ hạn duyệt" ĐÃ GỠ 25/09/2026 theo yêu cầu.

  // ============================================================
  // BỐ CỤC MỚI 20/11/2026 — trang này CEO và PTGĐ đọc trực tiếp
  //
  // 4 ô số · biểu đồ Doanh thu–Sản lượng theo dự án · Cam kết theo loại hợp đồng ·
  // Dự án đang âm · bảng cảnh báo (giữ nguyên như cũ).
  //
  // ⚠️ KHÔNG dựng 3 khối Ngân sách–Thực tế, Công nợ phải thu, Công nợ phải trả.
  //   Đã soi database 20/11: chỉ 1/11 dự án có BCTC còn hiệu lực; bảng claim không
  //   có ô "CĐT đã trả"; bill không có trạng thái "đã duyệt, chưa chi". Vẽ ô trống
  //   cho lãnh đạo xem còn tệ hơn không vẽ.
  //
  // ⚠️ Số liệu lấy NGUYÊN từ summaryRows/tGiaTriHD/... ở trên, KHÔNG tính lại.
  //   Tính lại ở hai chỗ là sớm muộn cũng lệch nhau mà không ai biết bên nào đúng.
  // ============================================================
  const tyVnd = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Chênh lệch để 2 số lẻ: nhiều dự án chênh vài trăm triệu, làm tròn 1 số lẻ thì
  // 149 triệu và 126 triệu đều ra "0,1 tỷ" — nhìn như nhau mà thực tế khác nhau.
  const tyVnd2 = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct1 = (v) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Dưới 1% ghi "<1" — làm tròn về 0 khiến người đọc tưởng chưa claim đồng nào
  const pctInt = (v) => (v > 0 && v < 1 ? '<1' : Math.round(v).toLocaleString('vi-VN'));

  const amRows = summaryRows.filter((r) => r.chenhLech < 0).sort((a, b) => a.chenhLech - b.chenhLech);

  // Ô "Chênh lệch" tổng ĐÃ BỎ 20/11/2026 theo yêu cầu. Chênh lệch vẫn xem được
  // theo từng dự án ở cột bên phải biểu đồ, và cộng tổng ở hàng TỔNG của bảng
  // trên điện thoại. Còn 3 ô: Giá trị HĐ · Doanh thu · Sản lượng.
  const tilesHtml = `
    <div style="display:grid;grid-template-columns:repeat(${IS_MOBILE ? 2 : 3},1fr);gap:${IS_MOBILE ? 10 : 14}px;margin-bottom:16px">
      <div class="card"><div class="card-sub" style="margin:0 0 6px">Giá trị hợp đồng đã ký với CĐT</div>
        <div style="font-size:${IS_MOBILE ? 22 : 29}px;font-weight:800;letter-spacing:-.5px">${tyVnd(tGiaTriHD)} tỷ</div>
        <div style="font-size:11.5px;color:var(--gray4);margin-top:5px">${fmt(tGiaTriHD)} đ</div></div>
      <div class="card"><div class="card-sub" style="margin:0 0 6px">Doanh thu — CĐT đã xác nhận</div>
        <div style="font-size:${IS_MOBILE ? 22 : 29}px;font-weight:800;letter-spacing:-.5px;color:#2a78d6">${tyVnd(tDoanhThu)} tỷ</div>
        <div style="font-size:11.5px;color:var(--gray4);margin-top:5px">${tGiaTriHD ? `đạt ${pct1((tDoanhThu / tGiaTriHD) * 100)}% giá trị hợp đồng` : 'chưa có giá trị HĐ'}</div></div>
      <div class="card" style="${IS_MOBILE ? 'grid-column:span 2' : ''}"><div class="card-sub" style="margin:0 0 6px">Sản lượng — tổng bill các đơn vị</div>
        <div style="font-size:${IS_MOBILE ? 22 : 29}px;font-weight:800;letter-spacing:-.5px;color:#eb6834">${tyVnd(tChiPhi)} tỷ</div>
        <div style="font-size:11.5px;color:var(--gray4);margin-top:5px">${tDoanhThu ? `bằng ${pct1((tChiPhi / tDoanhThu) * 100)}% doanh thu` : '—'}</div></div>
    </div>`;

  // ---- Biểu đồ Doanh thu vs Sản lượng theo dự án (chỉ máy tính) --------------
  // Xanh #2a78d6 / cam #eb6834: cặp màu đã kiểm bằng máy, người mù màu vẫn phân
  // biệt được (ΔE 24,7 — ngưỡng tối thiểu là 8) và in đen trắng vẫn khác sắc độ.
  //
  // ⚠️ SỐ NẰM NGAY SAU MỖI THANH (chốt 20/11): nhìn thanh biết hơn kém, đọc số
  //   biết bao nhiêu, không phải rê chuột. Vì nhãn chạy theo đuôi thanh nên
  //   BAR_W phải chừa đủ chỗ: thanh dài nhất + nhãn vẫn chưa chạm cột chênh lệch.
  //   Sửa BAR_W mà quên dời LAB_X là hai cụm chữ đè lên nhau.
  const chartRows = [...summaryRows].sort((a, b) => b.chenhLech - a.chenhLech);
  const maxChart = Math.max(1, ...chartRows.map((r) => Math.max(r.doanhThu, r.chiPhi)));
  const ROW_H = 50, BAR_H = 14, BAR_X = 262, BAR_W = 420, SVG_W = 1060;
  const LAB_X = BAR_X + BAR_W + 82;   // mốc cột "Chênh lệch"
  const chartH = chartRows.length * ROW_H + 46;
  const barLen = (v) => (v > 0 ? Math.max(3, (v / maxChart) * BAR_W) : 0);

  const tickStep = maxChart > 40e9 ? 10e9 : maxChart > 15e9 ? 5e9 : maxChart > 5e9 ? 2e9 : 1e9;
  let gridSvg = '';
  for (let t = 0; t <= maxChart; t += tickStep) {
    const x = BAR_X + (t / maxChart) * BAR_W;
    gridSvg += `<line x1="${x}" y1="28" x2="${x}" y2="${chartH - 18}" stroke="var(--gray2)" stroke-width="1"/>
      <text x="${x}" y="${chartH - 4}" text-anchor="middle" font-size="10.5" fill="var(--gray4)">${t / 1e9}</text>`;
  }

  const barsSvg = chartRows.map((r, i) => {
    const y = 34 + i * ROW_H;
    const neg = r.chenhLech < 0;
    const wDt = barLen(r.doanhThu), wSl = barLen(r.chiPhi);
    return `<g>
      <title>${esc(r.p.code)} — ${esc(r.p.name)}
Giá trị HĐ: ${r.giaTriHD == null ? 'chưa nhập' : fmt(r.giaTriHD) + ' đ'}
Doanh thu: ${fmt(r.doanhThu)} đ
Sản lượng: ${fmt(r.chiPhi)} đ
Chênh lệch: ${r.chenhLech >= 0 ? '+' : '−'}${fmt(Math.abs(r.chenhLech))} đ</title>
      <rect x="0" y="${y - 10}" width="${SVG_W}" height="${ROW_H - 6}" fill="transparent"/>
      <text x="250" y="${y + 12}" text-anchor="end" font-size="13.5" font-weight="700" fill="var(--gray7)">${esc(r.p.code)}</text>
      <text x="250" y="${y + 27}" text-anchor="end" font-size="10.5" fill="var(--gray4)">${r.giaTriHD == null ? 'chưa có giá trị HĐ' : `HĐ ${tyVnd(r.giaTriHD)} tỷ`}</text>
      <rect x="${BAR_X}" y="${y}" width="${wDt}" height="${BAR_H}" rx="4" fill="#2a78d6"/>
      <text x="${BAR_X + wDt + 7}" y="${y + 12}" font-size="11.5" font-weight="600" fill="var(--gray7)">${tyVnd(r.doanhThu)}</text>
      <rect x="${BAR_X}" y="${y + BAR_H + 2}" width="${wSl}" height="${BAR_H}" rx="4" fill="#eb6834"/>
      <text x="${BAR_X + wSl + 7}" y="${y + BAR_H + 14}" font-size="11.5" font-weight="600" fill="var(--gray7)">${tyVnd(r.chiPhi)}</text>
      <text x="${LAB_X}" y="${y + 13}" font-size="14" font-weight="700" fill="${neg ? 'var(--red)' : 'var(--green)'}">${neg ? '−' : '+'}${tyVnd2(Math.abs(r.chenhLech))} tỷ</text>
      <text x="${LAB_X}" y="${y + 29}" font-size="11" fill="var(--gray4)">${r.thuPct == null ? 'chưa có giá trị HĐ' : `đạt ${pctInt(r.thuPct)}% giá trị HĐ`}</text>
    </g>`;
  }).join('');

  const chartHtml = IS_MOBILE ? '' : `
    <div class="card" style="margin-bottom:12px">
      <div class="card-title" style="margin:0">Doanh thu và sản lượng theo dự án</div>
      <div class="card-sub">Xếp theo chênh lệch từ cao xuống thấp · số trên thanh và trục đều tính bằng tỷ đồng</div>
      <div style="display:flex;gap:18px;margin:10px 0 2px;font-size:13px;color:var(--gray6)">
        <span><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:#2a78d6;margin-right:6px"></span>Doanh thu (CĐT xác nhận)</span>
        <span><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:#eb6834;margin-right:6px"></span>Sản lượng (tổng bill các đơn vị)</span>
      </div>
      <svg viewBox="0 0 ${SVG_W} ${chartH}" width="100%" height="${chartH}" style="max-width:100%;display:block">${gridSvg}${barsSvg}</svg>
    </div>`;

  // ---- Cam kết theo loại hợp đồng -------------------------------------------
  // Giá trị hợp đồng ĐÃ KÝ với các đơn vị, không phải tiền đã chi.
  const scopeIds = new Set(summaryProjects.map((p) => p.id));
  const camKet = {};
  (contracts || []).forEach((c) => {
    if (c.status === 'cancelled') return;
    if (!scopeIds.has(c.project_id)) return;
    const k = c.contract_type || '(chưa phân loại)';
    camKet[k] = (camKet[k] || 0) + Number(c.value || 0);
  });
  let camKetList = Object.entries(camKet).sort((a, b) => b[1] - a[1]);
  // Quá 5 loại thì gộp đuôi lại — bảng xếp hạng dài không ai đọc tới dòng thứ 7
  if (camKetList.length > 5) {
    const khac = camKetList.slice(4).reduce((s, x) => s + x[1], 0);
    camKetList = [...camKetList.slice(0, 4), ['Các loại khác', khac]];
  }
  const camKetTong = camKetList.reduce((s, x) => s + x[1], 0);
  const camKetMax = Math.max(1, ...camKetList.map((x) => x[1]));
  const camKetHtml = camKetList.length
    ? `<div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin:0">Cam kết theo loại hợp đồng</div>
        <div class="card-sub">Giá trị hợp đồng đã ký với các đơn vị · tổng ${tyVnd(camKetTong)} tỷ</div>
        <div style="margin-top:12px">
          ${camKetList.map(([ten, v]) => `
            <div style="margin-bottom:13px">
              <div style="font-size:12.5px;color:var(--gray6);margin-bottom:5px">${esc(ten)}</div>
              <div style="display:flex;align-items:center;gap:9px">
                <div style="height:15px;border-radius:4px;background:#2a78d6;width:${Math.max(2, (v / camKetMax) * 100)}%;max-width:100%"></div>
                <div style="font-size:12.5px;font-weight:700;white-space:nowrap">${tyVnd(v)} tỷ</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`
    : '';

  // Khối "Việc đang chờ xử lý" ĐÃ BỎ 20/11/2026 theo yêu cầu — số hồ sơ chờ duyệt
  // đã tra được ở tab Duyệt hồ sơ và Hồ sơ của tôi, còn hồ sơ cảnh báo thì bảng
  // cảnh báo ngay bên dưới đã liệt kê đầy đủ từng dòng.

  // ---- Dự án đang âm ---------------------------------------------------------
  const amHtml = amRows.length
    ? `<div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin:0">${amRows.length} dự án đang âm</div>
        <div class="card-sub">Sản lượng đã vượt doanh thu CĐT xác nhận</div>
        ${amRows.map((r) => `
          <div style="border-left:3px solid var(--red);padding:9px 0 9px 12px;margin-top:11px">
            <div style="font-size:13px;font-weight:700;color:var(--red)">${esc(r.p.code)} · −${fmt(Math.abs(r.chenhLech))} đ</div>
            <div style="font-size:12px;color:var(--gray6);margin-top:4px;line-height:1.6">
              Sản lượng ${tyVnd(r.chiPhi)} tỷ so với doanh thu ${tyVnd(r.doanhThu)} tỷ${r.thuPct != null ? ` — CĐT mới xác nhận ${pctInt(r.thuPct)}% giá trị hợp đồng` : ' — dự án chưa có hợp đồng CĐT'}.
            </div>
          </div>`).join('')}
      </div>`
    : '';


  // Nén cho vừa MỘT màn hình (yêu cầu 20/11): bảng 11 dòng + 4 ô số + cột phải
  // cộng lại vượt chiều cao màn hình mặc định. Chỉ thu padding, KHÔNG thu cỡ chữ
  // số tiền — lãnh đạo đọc con số, không đọc khoảng trắng.
  const compactCss = `<style>
    #dashCompact .card{margin-bottom:12px}
    #dashCompact td{padding:7px 10px}
    #dashCompact th{padding:7px 10px}
    #dashCompact .card-sub{margin-bottom:8px}
  </style>`;

  container.innerHTML =
    compactCss +
    '<div id="dashCompact">' +
    tilesHtml +
    (IS_MOBILE
      ? summaryTableHtml + camKetHtml + amHtml
      : `<div style="display:grid;grid-template-columns:minmax(0,2.2fr) minmax(300px,1fr);gap:16px;align-items:start">
           <div>${chartHtml}</div>
           <div>${camKetHtml}${amHtml}</div>
         </div>`) +
    '</div>';
}
