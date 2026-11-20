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

  const tyVnd = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Chênh lệch để 2 số lẻ: nhiều dự án chênh vài trăm triệu, làm tròn 1 số lẻ thì
  // 149 triệu và 126 triệu đều ra "0,1 tỷ" — nhìn như nhau mà thực tế khác nhau.
  const tyVnd2 = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct1 = (v) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Dưới 1% ghi "<1" — làm tròn về 0 khiến người đọc tưởng chưa claim đồng nào
  const pctInt = (v) => (v > 0 && v < 1 ? '<1' : Math.round(v).toLocaleString('vi-VN'));

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

  // Bảng "Tổng hợp theo dự án" ĐÃ GỠ 20/11/2026: điện thoại nay cũng dùng biểu đồ
  // thanh như máy tính, nên bảng số không còn nơi nào hiển thị. Mọi con số của
  // bảng đều có trên biểu đồ (doanh thu, sản lượng, chênh lệch, % HĐ, giá trị HĐ).

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

  const amRows = summaryRows.filter((r) => r.chenhLech < 0).sort((a, b) => a.chenhLech - b.chenhLech);

  // Ô "Chênh lệch" tổng ĐÃ BỎ 20/11/2026 theo yêu cầu. Chênh lệch vẫn xem được
  // theo từng dự án ở cột bên phải biểu đồ, và cộng tổng ở hàng TỔNG của bảng
  // trên điện thoại. Còn 3 ô: Giá trị HĐ · Doanh thu · Sản lượng.
  // ⚠️ TRÊN ĐIỆN THOẠI 3 Ô NẰM MỘT HÀNG, chữ ngắn lại (sửa 20/11 sau khi xem màn
  //   gập thật): bản cũ xếp 2+1, nhãn dài xuống 2-3 dòng, 3 con số ăn gần một
  //   phần tư màn hình — phải cuộn mới tới bảng. Nhãn dài giữ cho máy tính.
  const TILES = [
    { k: IS_MOBILE ? 'Giá trị HĐ' : 'Giá trị hợp đồng đã ký với CĐT', v: tyVnd(tGiaTriHD), color: '',
      f: IS_MOBILE ? '' : `${fmt(tGiaTriHD)} đ` },
    { k: IS_MOBILE ? 'Doanh thu' : 'Doanh thu — CĐT đã xác nhận', v: tyVnd(tDoanhThu), color: '#2a78d6',
      f: tGiaTriHD ? `đạt ${pct1((tDoanhThu / tGiaTriHD) * 100)}%${IS_MOBILE ? ' HĐ' : ' giá trị hợp đồng'}` : 'chưa có giá trị HĐ' },
    { k: IS_MOBILE ? 'Sản lượng' : 'Sản lượng — tổng bill các đơn vị', v: tyVnd(tChiPhi), color: '#eb6834',
      f: tDoanhThu ? `bằng ${pct1((tChiPhi / tDoanhThu) * 100)}%${IS_MOBILE ? ' DT' : ' doanh thu'}` : '—' },
  ];
  const tilesHtml = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:${IS_MOBILE ? 8 : 14}px;margin-bottom:${IS_MOBILE ? 12 : 16}px">
      ${TILES.map((t) => `<div class="card" style="${IS_MOBILE ? 'padding:10px 11px' : ''}">
        <div class="card-sub" style="margin:0 0 4px;${IS_MOBILE ? 'font-size:11px;white-space:nowrap' : ''}">${t.k}</div>
        <div style="font-size:${IS_MOBILE ? 19 : 29}px;font-weight:800;letter-spacing:-.5px;white-space:nowrap;${t.color ? `color:${t.color}` : ''}">${t.v} tỷ</div>
        ${t.f ? `<div style="font-size:${IS_MOBILE ? 10.5 : 11.5}px;color:var(--gray4);margin-top:4px;white-space:nowrap">${t.f}</div>` : ''}
      </div>`).join('')}
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

  // ⚠️ HAI HÌNH DẠNG KHÁC HẲN NHAU, KHÔNG PHẢI MỘT HÌNH THU NHỎ (sửa 20/11):
  //   Máy tính xếp NGANG: tên dự án | thanh | chênh lệch — tận dụng bề ngang.
  //   Điện thoại xếp DỌC: tên dự án và chênh lệch một dòng, hai thanh nằm dưới.
  //   Nếu bê nguyên khung 1060px xuống màn 412px thì chữ co còn ~5px, không đọc
  //   nổi. Nên màn hẹp có khung riêng, chữ giữ nguyên cỡ thật.
  //
  // ⚠️ KHUNG MÀN HẸP PHẢI ĐO THEO BỀ NGANG MÁY, KHÔNG ĐẶT CỨNG (sửa 20/11):
  //   IS_MOBILE trong utils.js xét user-agent, KHÔNG xét bề ngang. Màn gập mở ra
  //   vẫn là IS_MOBILE nhưng rộng gấp đôi, nên khung cứng 400px bị svg phóng to
  //   theo container (~1,7 lần) và CHỮ TO VỐNG LÊN — đúng lỗi anh Toàn báo.
  //   Nay lấy innerWidth trừ lề (trang 2×12 + thẻ 2×12 ≈ 48) làm bề ngang khung,
  //   chặn trong [330, 760] để màn quá hẹp không vỡ và máy tính bảng không loãng.
  const VPW = (typeof window !== 'undefined' && window.innerWidth) || 400;
  const mobW = Math.max(330, Math.min(VPW - 48, 760));
  const CH = IS_MOBILE
    ? { W: mobW, ROW: 62, BAR_X: 0, BAR_W: mobW - 50, BAR_H: 12, PAD_TOP: 16, PAD_BOT: 24 }
    : { W: 1060, ROW: 50, BAR_X: 262, BAR_W: 420, BAR_H: 14, PAD_TOP: 34, PAD_BOT: 46 };
  const LAB_X = CH.BAR_X + CH.BAR_W + 82;   // mốc cột "Chênh lệch" (chỉ máy tính)
  const chartH = chartRows.length * CH.ROW + CH.PAD_BOT;
  const barLen = (v) => (v > 0 ? Math.max(3, (v / maxChart) * CH.BAR_W) : 0);

  const tickStep = maxChart > 40e9 ? 10e9 : maxChart > 15e9 ? 5e9 : maxChart > 5e9 ? 2e9 : 1e9;
  let gridSvg = '';
  for (let t = 0; t <= maxChart; t += tickStep) {
    const x = CH.BAR_X + (t / maxChart) * CH.BAR_W;
    // Vạch đầu căn trái, vạch cuối căn phải — căn giữa thì nửa chữ số lòi ra
    // ngoài khung svg và bị cắt mất (lỗi thấy trên màn gập 412px).
    const anchor = t === 0 ? 'start' : t + tickStep > maxChart ? 'end' : 'middle';
    gridSvg += `<line x1="${x}" y1="${IS_MOBILE ? 4 : 28}" x2="${x}" y2="${chartH - 18}" stroke="var(--gray2)" stroke-width="1"/>
      <text x="${x}" y="${chartH - 4}" text-anchor="${anchor}" font-size="10.5" fill="var(--gray4)">${t / 1e9}</text>`;
  }

  const tip = (r) => `${esc(r.p.code)} — ${esc(r.p.name)}
Giá trị HĐ: ${r.giaTriHD == null ? 'chưa nhập' : fmt(r.giaTriHD) + ' đ'}
Doanh thu: ${fmt(r.doanhThu)} đ
Sản lượng: ${fmt(r.chiPhi)} đ
Chênh lệch: ${r.chenhLech >= 0 ? '+' : '−'}${fmt(Math.abs(r.chenhLech))} đ`;

  const barsSvg = chartRows.map((r, i) => {
    const y = CH.PAD_TOP + i * CH.ROW;
    const neg = r.chenhLech < 0;
    const wDt = barLen(r.doanhThu), wSl = barLen(r.chiPhi);
    const col = neg ? 'var(--red)' : 'var(--green)';
    const chenh = `${neg ? '−' : '+'}${tyVnd2(Math.abs(r.chenhLech))} tỷ`;
    const hd = r.giaTriHD == null ? 'chưa có giá trị HĐ' : `HĐ ${tyVnd(r.giaTriHD)} tỷ`;
    const pctTxt = r.thuPct == null ? '' : `đạt ${pctInt(r.thuPct)}% HĐ`;

    if (IS_MOBILE) {
      // Dòng 1: mã dự án (trái) · chênh lệch (phải). Dòng 2: giá trị HĐ · % HĐ.
      // Dòng 3-4: hai thanh, số ngay sau đuôi thanh.
      return `<g><title>${tip(r)}</title>
      <text x="0" y="${y}" font-size="12.5" font-weight="700" fill="var(--gray7)">${esc(r.p.code)}</text>
      <text x="${CH.W}" y="${y}" text-anchor="end" font-size="12.5" font-weight="700" fill="${col}">${chenh}</text>
      <text x="0" y="${y + 13}" font-size="10" fill="var(--gray4)">${hd}</text>
      <text x="${CH.W}" y="${y + 13}" text-anchor="end" font-size="10" fill="var(--gray4)">${pctTxt}</text>
      <rect x="0" y="${y + 19}" width="${wDt}" height="${CH.BAR_H}" rx="3" fill="#2a78d6"/>
      <text x="${wDt + 6}" y="${y + 29}" font-size="10.5" font-weight="600" fill="var(--gray7)">${tyVnd2(r.doanhThu)}</text>
      <rect x="0" y="${y + 19 + CH.BAR_H + 2}" width="${wSl}" height="${CH.BAR_H}" rx="3" fill="#eb6834"/>
      <text x="${wSl + 6}" y="${y + 29 + CH.BAR_H + 2}" font-size="10.5" font-weight="600" fill="var(--gray7)">${tyVnd2(r.chiPhi)}</text>
    </g>`;
    }
    return `<g><title>${tip(r)}</title>
      <rect x="0" y="${y - 10}" width="${CH.W}" height="${CH.ROW - 6}" fill="transparent"/>
      <text x="250" y="${y + 12}" text-anchor="end" font-size="13.5" font-weight="700" fill="var(--gray7)">${esc(r.p.code)}</text>
      <text x="250" y="${y + 27}" text-anchor="end" font-size="10.5" fill="var(--gray4)">${hd}</text>
      <rect x="${CH.BAR_X}" y="${y}" width="${wDt}" height="${CH.BAR_H}" rx="4" fill="#2a78d6"/>
      <text x="${CH.BAR_X + wDt + 7}" y="${y + 12}" font-size="11.5" font-weight="600" fill="var(--gray7)">${tyVnd(r.doanhThu)}</text>
      <rect x="${CH.BAR_X}" y="${y + CH.BAR_H + 2}" width="${wSl}" height="${CH.BAR_
