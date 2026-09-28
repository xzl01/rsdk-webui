"""Read generated Wi-Fi configuration through libnm, without changing the host."""
import ctypes as c
import ctypes.util
import json
import sys

if not ctypes.util.find_library('nm') or not ctypes.util.find_library('glib-2.0'):
    sys.exit(77)
glib = c.CDLL(ctypes.util.find_library('glib-2.0'))
nm = c.CDLL(ctypes.util.find_library('nm'))
ptr = c.c_void_p

def bind(lib, name, args, result):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, result
    return fn

new_keyfile = bind(glib, 'g_key_file_new', [], ptr)
load = bind(glib, 'g_key_file_load_from_data', [ptr, c.c_char_p, c.c_size_t, c.c_int, ptr], c.c_int)
read = bind(nm, 'nm_keyfile_read', [ptr, c.c_char_p, c.c_int, ptr, ptr, ptr], ptr)
wireless = bind(nm, 'nm_connection_get_setting_wireless', [ptr], ptr)
ssid = bind(nm, 'nm_setting_wireless_get_ssid', [ptr], ptr)
bytes_data = bind(glib, 'g_bytes_get_data', [ptr, c.POINTER(c.c_size_t)], ptr)
security = bind(nm, 'nm_connection_get_setting_wireless_security', [ptr], ptr)
psk = bind(nm, 'nm_setting_wireless_security_get_psk', [ptr], c.c_char_p)
results = []
for keyfile in json.load(sys.stdin):
    data = keyfile.encode()
    key = new_keyfile()
    assert load(key, data, len(data), 0, None)
    connection = read(key, b'/', 0, None, None, None)
    assert connection
    size = c.c_size_t()
    raw = bytes_data(ssid(wireless(connection)), c.byref(size))
    results.append({'ssid': c.string_at(raw, size.value).decode(), 'psk': psk(security(connection)).decode()})
print(json.dumps(results))
