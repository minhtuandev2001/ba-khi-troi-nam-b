import { validatePassword } from './shared/validation';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name} (đặt trong backend/.env hoặc trên nền tảng deploy)`);
  return value;
}

const production = process.env.NODE_ENV === 'production';

function jwtSecret(): string {
  const secret = required('JWT_SECRET');
  if (secret.length < 32 || /change-me/i.test(secret)) {
    const text = 'JWT_SECRET phải là chuỗi ngẫu nhiên dài ít nhất 32 ký tự (tạo bằng: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))")';
    if (production) throw new Error(text);
    console.warn(`[config] ${text}`);
  }
  return secret;
}

const ADMIN_PASSWORD_MIN_LENGTH = 12;

/** Why `value` is not acceptable as the admin password, or null when it is. */
export function adminPasswordProblem(value: string | null): string | null {
  if (!value) return 'Thiếu biến môi trường ADMIN_PASSWORD (mật khẩu tài khoản admin)';
  if (value.length < ADMIN_PASSWORD_MIN_LENGTH || validatePassword(value, 'admin').length) {
    return `ADMIN_PASSWORD quá yếu: cần ít nhất ${ADMIN_PASSWORD_MIN_LENGTH} ký tự, có chữ hoa, chữ thường, số, ký tự đặc biệt, không có khoảng trắng và không chứa chữ "admin"`;
  }
  return null;
}

/**
 * Password of the built-in `admin` account. Required and strong in production; in development it may be left
 * out, and then the stored admin password is kept as is.
 */
function adminPassword(): string | null {
  const value = process.env.ADMIN_PASSWORD || null;
  const problem = adminPasswordProblem(value);
  if (problem) {
    if (production) throw new Error(problem);
    if (value) console.warn(`[config] ${problem}`);
  }
  return value;
}

/** Number of reverse proxies in front of the server; 0 means clients connect directly. */
function trustProxy(): number {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return production ? 1 : 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('TRUST_PROXY phải là số proxy đứng trước server (0, 1, 2...)');
  return hops;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: jwtSecret(),
  jwtExpiresIn: '7d' as const,
  adminPassword: adminPassword(),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  production,
  trustProxy: trustProxy(),
  requireHttps: production && process.env.REQUIRE_HTTPS !== 'false',
};
