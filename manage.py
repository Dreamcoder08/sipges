"""Tareas de administración local de MASCLI.

Uso (con las mismas variables MASCLI_* que el servidor):
  python manage.py reset-mfa <usuario>       Quita el MFA y cierra sus sesiones
  python manage.py set-password <usuario>    Cambia la contraseña (se pide por consola)
"""
import getpass, sys

import app


def main(argv):
    if len(argv) != 2 or argv[0] not in ("reset-mfa", "set-password"):
        print(__doc__)
        return 2
    command, username = argv[0], argv[1].strip().lower()
    app.init_auth_global()
    if command == "reset-mfa":
        if not app.reset_mfa(username):
            print(f"Usuario inexistente: {username}")
            return 1
        print(f"MFA restablecido para {username}. Deberá registrarlo de nuevo en su próximo ingreso.")
        return 0
    password = getpass.getpass("Nueva contraseña (mínimo 12 caracteres): ")
    if len(password) < 12 or password != getpass.getpass("Repita la contraseña: "):
        print("Contraseña demasiado corta o no coincide.")
        return 1
    c = app.auth_conn()
    try:
        changed = c.execute("UPDATE auth_users SET password_hash=? WHERE username=?", (app.hash_password(password), username)).rowcount
        c.execute("DELETE FROM auth_sessions WHERE username=?", (username,))
        c.commit()
    finally:
        c.close()
    print("Contraseña actualizada." if changed else f"Usuario inexistente: {username}")
    return 0 if changed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
