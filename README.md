# Self-reflection – Today's Reflection

Ứng dụng nhìn lại bản thân hằng ngày: check-in cảm xúc, nhật ký, thói quen, insights.

## Kiến trúc
- **Frontend**: `index.html` (HTML/CSS/JS thuần), gọi API bằng `fetch`.
- **Backend**: `server.js` (Node.js), REST API + phục vụ file tĩnh.
- **Cơ sở dữ liệu** (tự chọn theo môi trường):
  - Có biến `DATABASE_URL` → **PostgreSQL** (schema: `schema.pg.sql`, thư viện `pg`).
  - Không có → **SQLite** (`data.db`, schema: `schema.sql`).
- **Xác thực**: đăng ký / đăng nhập, mật khẩu băm bằng scrypt + salt, phiên đăng nhập bằng token (30 ngày). Dữ liệu tách riêng theo từng tài khoản và đồng bộ trên mọi thiết bị.

## Cơ sở dữ liệu (`schema.sql`)
`users`, `sessions`, `moods`, `journals`, `habits`, `habit_logs` – liên kết bằng khóa ngoại, xóa tài khoản/thói quen sẽ xóa dữ liệu liên quan (ON DELETE CASCADE).

## API
| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/register`, `/api/login`, `/api/logout` | Tài khoản |
| GET | `/api/me` | Thông tin + toàn bộ dữ liệu của người dùng |
| POST / PUT / DELETE | `/api/moods`, `/api/moods/:id` | Check-in cảm xúc |
| POST / PUT / DELETE | `/api/journals`, `/api/journals/:id` | Nhật ký |
| POST / PUT / DELETE | `/api/habits`, `/api/habits/:id` | Thói quen |
| PUT | `/api/habits/:id/log` | Tích/bỏ tích thói quen theo ngày |
| DELETE | `/api/data` | Xóa toàn bộ dữ liệu cá nhân |

## Chạy
```bash
node server.js          # hoặc: npm start
# mở http://localhost:3000
```
Biến môi trường tùy chọn: `PORT`, `DATABASE_URL` (Postgres), `DB_FILE` (đường dẫn file SQLite).
Chạy `npm install` trước nếu muốn dùng Postgres.
