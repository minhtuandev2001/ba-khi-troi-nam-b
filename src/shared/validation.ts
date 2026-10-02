import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './constants';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED = ['admin', 'administrator', 'root', 'system', 'bot', 'moderator', 'support'];

export function validateUsername(name: unknown): string[] {
  const errors: string[] = [];
  if (typeof name !== 'string') return ['Tên đăng nhập không hợp lệ.'];
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    errors.push(`Tên đăng nhập phải dài từ ${NAME_MIN_LENGTH} đến ${NAME_MAX_LENGTH} ký tự.`);
  }
  if (!USERNAME_RE.test(name)) {
    errors.push('Tên đăng nhập phải bắt đầu bằng chữ cái và chỉ gồm chữ không dấu, số hoặc dấu gạch dưới (_).');
  }
  if (RESERVED.some((r) => name.toLowerCase().startsWith(r))) {
    errors.push('Tên đăng nhập này đã được hệ thống giữ lại, hãy chọn tên khác.');
  }
  return errors;
}

export function validatePassword(password: unknown, username = ''): string[] {
  const errors: string[] = [];
  if (typeof password !== 'string') return ['Mật khẩu không hợp lệ.'];
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Mật khẩu phải dài từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự.`);
  }
  if (!/[A-Z]/.test(password)) errors.push('Mật khẩu phải có ít nhất 1 chữ in hoa (A-Z).');
  if (!/[a-z]/.test(password)) errors.push('Mật khẩu phải có ít nhất 1 chữ thường (a-z).');
  if (!/[0-9]/.test(password)) errors.push('Mật khẩu phải có ít nhất 1 chữ số (0-9).');
  if (!/[^A-Za-z0-9\s]/.test(password)) errors.push('Mật khẩu phải có ít nhất 1 ký tự đặc biệt (ví dụ: ! @ # $ % ^ & *).');
  if (/\s/.test(password)) errors.push('Mật khẩu không được chứa khoảng trắng.');
  if (username.length >= NAME_MIN_LENGTH && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Mật khẩu không được chứa tên đăng nhập.');
  }
  return errors;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
