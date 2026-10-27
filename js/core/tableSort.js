/* =====================================================================
   js/core/tableSort.js — SẮP XẾP BẢNG BẰNG CÁCH BẤM VÀO TIÊU ĐỀ CỘT
   =====================================================================
   ⚠️ VÌ SAO KHÔNG SẮP XẾP TRỰC TIẾP CÁC DÒNG ĐANG HIỆN
     Bảng Hợp đồng và Bill thanh toán đều CÓ PHÂN TRANG. Nếu chỉ đảo các
     dòng đang hiện thì "Giá trị hợp đồng từ cao xuống thấp" chỉ đúng
     trong phạm vi trang đang xem — hợp đồng lớn nhất nằm ở trang 3 sẽ
     không bao giờ lên đầu. Người đọc tưởng đang xem cái lớn nhất, thực
     tế không phải. Sai kiểu này nguy hơn báo lỗi, vì nó im lặng.

     Nên module này sắp xếp DANH SÁCH DỮ LIỆU trước, rồi mới cắt trang.

   DÙNG THẾ NÀO
     1) Khai báo mỗi cột lấy giá trị gì để so sánh (null = cột không sắp):

        const COLS = [
          { get: (b) => b.projects?.code },      // cột 1 — chữ
          { get: (b) => b.partners?.name },      // cột 2 — chữ
          { get: (b) => Number(b.period_no) },   // cột 3 — số
          null,                                  // cột 4 — không cho sắp
        ];

     2) Tạo bộ sắp xếp, nhớ theo key để lọc xong không mất:

        const sorter = makeSorter({
          key: 'bill',
          columns: COLS,
          onChange: () => { VIEW_PAGE = 1; draw(); },
        });

     3) Gắn vào bảng NGAY SAU khi đổ HTML:   sorter.attach(table);

     4) Trong draw(), sắp xếp TRƯỚC khi cắt trang:
            const view = sorter.apply(currentList);
            const pageItems = view.slice(dau, cuoi);

   BẤM BA LẦN
     lần 1 → tăng dần ▲   lần 2 → giảm dần ▼   lần 3 → về thứ tự mặc định

   SO SÁNH THẾ NÀO
     · Số    → so theo giá trị. 2.850.000.000 lớn hơn 335.500.000.
     · Chữ   → theo bảng chữ cái tiếng Việt, có dấu hay không đều đúng;
               và "Đợt 2" đứng trước "Đợt 11" (so phần số).
     · Rỗng  → luôn xuống CUỐI, cả khi tăng lẫn khi giảm. Ô trống không
               phải là "nhỏ nhất", nó là "không có số liệu".
     · Bằng nhau → giữ nguyên thứ tự mặc định, không xáo lung tung.

   HIỆU NĂNG
     Giá trị so sánh được tính MỘT LẦN cho mỗi dòng rồi mới sắp, không
     gọi lại hàm get() ở từng phép so sánh. Quan trọng với cột phải tính
     toán như calcBill().
   ===================================================================== */

/* Nhớ cột đang sắp của từng bảng, sống qua các lần vẽ lại. */
const STATE = new Map();

/* numeric:true để "Đợt 2" < "Đợt 11"; sensitivity:'base' để không phân
   biệt hoa thường và không phân biệt dấu khi xếp. */
const COLLATOR = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function isEmpty(v) {
  return v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
}

function compare(a, b) {
  const ea = isEmpty(a), eb = isEmpty(b);
  if (ea && eb) return 0;
  if (ea) return 1;          // rỗng xuống cuối
  if (eb) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Number(a);
    const tb = b instanceof Date ? b.getTime() : Number(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  return COLLATOR.compare(String(a), String(b));
}

export function makeSorter({ key = null, columns = [], onChange = null } = {}) {
  let attached = null;

  function current() {
    return key ? STATE.get(key) || null : attached?.__localSort || null;
  }

  function setCurrent(v) {
    if (key) { if (v) STATE.set(key, v); else STATE.delete(key); }
    else if (attached) attached.__localSort = v;
  }

  /* ---- Sắp xếp danh sách dữ liệu ---- */
  function apply(list) {
    const st = current();
    const arr = Array.isArray(list) ? list : [];
    const col = st && columns[st.col];
    if (!st || !col || typeof col.get !== 'function') return arr;

    const sign = st.dir === 'desc' ? -1 : 1;

    /* Tính giá trị so sánh MỘT LẦN cho mỗi dòng. */
    const deco = arr.map((item, i) => {
      let v;
      try { v = col.get(item); } catch (e) { v = null; }
      return { item, v, i };
    });

    deco.sort((x, y) => {
      /* ⚠️ Ô RỖNG XỬ LÝ RIÊNG, KHÔNG NHÂN VỚI sign.
         Nếu để nó đi qua phép nhân thì khi sắp giảm dần, dấu âm sẽ hất
         mọi dòng không có số liệu lên ĐẦU bảng — người đọc tưởng đó là
         những hợp đồng lớn nhất. Rỗng phải nằm cuối ở CẢ hai chiều. */
      const ex = isEmpty(x.v), ey = isEmpty(y.v);
      if (ex && ey) return x.i - y.i;
      if (ex) return 1;
      if (ey) return -1;

      const c = compare(x.v, y.v);
      if (c !== 0) return c * sign;
      return x.i - y.i;                 // bằng nhau thì giữ thứ tự gốc
    });

    return deco.map((d) => d.item);
  }

  /* ---- Gắn vào <table>, biến <th> thành nút bấm ---- */
  function attach(table) {
    if (!table) return;
    const head = table.tHead;
    const headRow = head ? head.rows[head.rows.length - 1] : null;
    if (!headRow) {
      console.warn('[tableSort.js] Bảng không có <thead>, bỏ qua sắp xếp.');
      return;
    }

    injectStyle(table.ownerDocument);
    table.classList.add('vela-sortable');
    attached = table;

    const ths = Array.from(headRow.cells);
    if (ths.length !== columns.length) {
      console.warn(`[tableSort.js] Bảng có ${ths.length} cột nhưng khai báo ${columns.length} cột. Kiểm tra lại mảng columns — lệch là bấm cột này ra kết quả cột kia.`);
    }

    ths.forEach((th, col) => {
      const def = columns[col];
      if (!def || typeof def.get !== 'function') return;   // cột không cho sắp

      th.classList.add('vela-sort-th');
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.title = 'Bấm để sắp xếp';

      if (!th.querySelector('.vela-sort-ind')) {
        const ind = table.ownerDocument.createElement('span');
        ind.className = 'vela-sort-ind';
        th.appendChild(ind);
      }

      const fire = () => {
        const cur = current();
        let next;
        if (!cur || cur.col !== col) next = { col, dir: 'asc' };
        else if (cur.dir === 'asc') next = { col, dir: 'desc' };
        else next = null;                                   // lần 3 → mặc định
        setCurrent(next);
        paint(headRow);
        if (typeof onChange === 'function') onChange(next);
      };

      th.addEventListener('click', fire);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
      });
    });

    paint(headRow);     // vẽ lại mũi tên theo trạng thái đã nhớ
  }

  function paint(headRow) {
    const st = current();
    Array.from(headRow.cells).forEach((th, i) => {
      th.classList.remove('vela-sort-asc', 'vela-sort-desc');
      const ind = th.querySelector && th.querySelector('.vela-sort-ind');
      if (ind) ind.textContent = '';
      if (st && st.col === i) {
        th.classList.add(st.dir === 'asc' ? 'vela-sort-asc' : 'vela-sort-desc');
        if (ind) ind.textContent = st.dir === 'asc' ? ' ▲' : ' ▼';
      }
    });
  }

  return { attach, apply, get state() { return current(); }, reset() { setCurrent(null); } };
}

/* Xóa trí nhớ sắp xếp. Không truyền key thì xóa sạch. */
export function resetSort(key) {
  if (key) STATE.delete(key); else STATE.clear();
}

function injectStyle(doc) {
  if (!doc || doc.getElementById('vela-tablesort-css')) return;
  const st = doc.createElement('style');
  st.id = 'vela-tablesort-css';
  st.textContent = `
.vela-sortable th.vela-sort-th{cursor:pointer;user-select:none;-webkit-user-select:none;white-space:nowrap}
.vela-sortable th.vela-sort-th:hover{background:rgba(37,99,235,.08)}
.vela-sortable th.vela-sort-th:focus-visible{outline:2px solid #2563eb;outline-offset:-2px}
.vela-sortable th.vela-sort-asc,.vela-sortable th.vela-sort-desc{color:#2563eb}
.vela-sort-ind{font-size:.78em}
.vela-sortable th.vela-sort-th::after{content:'⇅';opacity:.25;font-size:.78em;margin-left:4px}
.vela-sortable th.vela-sort-asc::after,.vela-sortable th.vela-sort-desc::after{content:''}
`;
  (doc.head || doc.documentElement).appendChild(st);
}
