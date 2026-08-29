// Service Worker TỐI GIẢN — chỉ tồn tại để trình duyệt cho phép "Cài đặt"
// app lên màn hình chính (điều kiện bắt buộc trên nhiều trình duyệt).
// KHÔNG cache bất kỳ dữ liệu nào — app luôn cần dữ liệu mới nhất từ
// Supabase, cache sai sẽ gây hiển thị nhầm thông tin cũ.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // không can thiệp gì, để mạng tự xử lý bình thường
