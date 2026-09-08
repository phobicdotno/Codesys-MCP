import sys, scriptengine as script_engine, os, traceback

DEVICE_PATH = "{DEVICE_PATH}"
PARAM_NAME = {PARAM_NAME}
PARAM_ID = r"{PARAM_ID}"
NEW_VALUE = {NEW_VALUE}
# '' for NEW_VALUE_SENTINEL means read-only (get mode).
GET_ONLY = {GET_ONLY}
# '' = whole parameter; an integer = one array/struct sub-element (0-based).
ELEMENT_INDEX = r"{ELEMENT_INDEX}"

def _matches(param):
    if PARAM_ID:
        try:
            if str(getattr(param, 'id', None)) == PARAM_ID:
                return True
        except Exception:
            pass
    if PARAM_NAME:
        for attr in ('name', 'visible_name'):
            try:
                if str(getattr(param, attr, None)) == PARAM_NAME:
                    return True
            except Exception:
                pass
    return False

def _sub_elements(param):
    """Array/struct parameters (e.g. a Modbus TCP holding-register array)
    don't accept a scalar write on .value -- their data lives in child value
    elements. The ScriptEngine surface for those children varies by SP, so
    probe the known shapes; [] means 'scalar parameter'."""
    # SP21: a struct/array parameter is a ScriptCompoundDeviceParameter, a
    # .NET list of child elements (Count + indexer + GetEnumerator) with
    # has_sub_elements = True. Its own .value is the '{a, b}' text and
    # rejects writes ("Operation not allowed on struct types"); the children
    # take the scalar writes. Seen on the CC100 751-9402 'AI Setup' (s_AnalogMode.Mode).
    try:
        if getattr(param, 'has_sub_elements', False):
            try:
                lst = list(param)
                if lst:
                    return lst
            except Exception:
                pass
            count = int(getattr(param, 'Count', 0) or 0)
            if count:
                return [param[i] for i in range(count)]
    except Exception:
        pass
    for attr in ('sub_elements', 'elements', 'data_elements'):
        try:
            subs = getattr(param, attr, None)
            if subs is not None:
                lst = list(subs)
                if lst:
                    return lst
        except Exception:
            pass
    try:
        count = None
        for cattr in ('sub_element_count', 'element_count'):
            c = getattr(param, cattr, None)
            if c is not None:
                count = int(c)
                break
        if count:
            getter = getattr(param, 'get_sub_element', None) or getattr(param, 'get_element', None)
            if getter is not None:
                return [getter(i) for i in range(count)]
    except Exception:
        pass
    return []


def _elem_label(elem, index):
    for attr in ('name', 'visible_name', 'identifier'):
        try:
            v = getattr(elem, attr, None)
            if v:
                return str(v)
        except Exception:
            pass
    return "[%d]" % index


def _elem_value(elem):
    try:
        return elem.value
    except Exception as e:
        return '<unreadable: %s>' % e


def _set_elem_value(elem, label, text):
    try:
        elem.value = text
    except Exception as e:
        api = sorted([a for a in dir(elem) if not a.startswith('_')])
        raise RuntimeError("Failed to write sub-element %s = '%s': %s. Element API: %s" % (
            label, text, e, ", ".join(api)))


def _parse_array_literal(text):
    """'[1, 2, 3]' -> ['1','2','3']; None when the text isn't a bracketed list."""
    s = text.strip()
    if not (s.startswith('[') and s.endswith(']')):
        return None
    inner = s[1:-1].strip()
    if not inner:
        return []
    return [part.strip() for part in inner.split(',')]


def _iter_params(device):
    try:
        for param in (device.device_parameters or []):
            yield 'device', param
    except Exception as e:
        print("DEBUG: device_parameters walk failed: %s" % e)
    try:
        connectors = list(device.connectors or [])
    except Exception:
        connectors = []
    for i, conn in enumerate(connectors):
        scope = "connector[%d]:%s" % (i, getattr(conn, 'interface', '?'))
        try:
            for param in (getattr(conn, 'parameters', None) or []):
                yield scope, param
        except Exception as e:
            print("DEBUG: parameter walk failed for %s: %s" % (scope, e))
        # ScriptConnector exposes the host-side parameter set (e.g. the WAGO
        # "K-BUS Parameters" grid) only via host_parameters, not parameters.
        try:
            for param in (getattr(conn, 'host_parameters', None) or []):
                yield scope + ':host', param
        except Exception as e:
            print("DEBUG: host_parameter walk failed for %s: %s" % (scope, e))

try:
    print("DEBUG: set_device_parameter script: Device='%s', Name='%s', Id='%s', GetOnly=%s, Project='%s'" % (
        DEVICE_PATH, PARAM_NAME, PARAM_ID, GET_ONLY, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PARAM_NAME and not PARAM_ID:
        raise ValueError("Provide parameterName or parameterId.")
    device = find_device_object(primary_project, DEVICE_PATH)
    dev_name = getattr(device, 'get_name', lambda: "Unknown")()

    found_scope, found = None, None
    for scope, param in _iter_params(device):
        if _matches(param):
            found_scope, found = scope, param
            break
    if found is None:
        raise ValueError("Parameter not found (name='%s', id='%s') on device '%s'. Use list_device_parameters." % (
            PARAM_NAME, PARAM_ID, dev_name))

    name = getattr(found, 'name', None) or getattr(found, 'visible_name', '?')
    subs = _sub_elements(found)
    old_value = '<unreadable>'
    try:
        old_value = found.value
    except Exception as e:
        if GET_ONLY and not subs:
            raise RuntimeError("Parameter '%s' has no readable value element: %s" % (name, e))

    if GET_ONLY:
        print("Device: %s" % dev_name)
        print("Scope: %s" % found_scope)
        print("Parameter: %s" % name)
        print("Value: %s" % old_value)
        if subs:
            print("SubElements: %d" % len(subs))
            for i, elem in enumerate(subs):
                print("  [%d] %s = %s" % (i, _elem_label(elem, i), _elem_value(elem)))
        print("SCRIPT_SUCCESS: Parameter read.")
    else:
        if ELEMENT_INDEX != '':
            # Single array/struct element write.
            idx = int(ELEMENT_INDEX)
            if not subs:
                raise ValueError("elementIndex=%d given but parameter '%s' has no sub-elements (scalar parameter)." % (idx, name))
            if idx < 0 or idx >= len(subs):
                raise ValueError("elementIndex %d out of range for parameter '%s' (0..%d)." % (idx, name, len(subs) - 1))
            label = _elem_label(subs[idx], idx)
            old_elem = _elem_value(subs[idx])
            _set_elem_value(subs[idx], label, NEW_VALUE)
            primary_project.save()
            print("Device: %s" % dev_name)
            print("Scope: %s" % found_scope)
            print("Parameter: %s" % name)
            print("Element: [%d] %s" % (idx, label))
            print("Old Value: %s" % old_elem)
            print("New Value: %s" % NEW_VALUE)
            print("SCRIPT_SUCCESS: Parameter element set. Project saved.")
        else:
            values = _parse_array_literal(NEW_VALUE) if subs else None
            if subs and values is not None:
                # Whole-array write from a bracketed literal, element-wise.
                if len(values) != len(subs):
                    raise ValueError("Array value has %d element(s) but parameter '%s' has %d sub-element(s)." % (
                        len(values), name, len(subs)))
                for i, (elem, text) in enumerate(zip(subs, values)):
                    _set_elem_value(elem, _elem_label(elem, i), text)
                primary_project.save()
                print("Device: %s" % dev_name)
                print("Scope: %s" % found_scope)
                print("Parameter: %s" % name)
                print("Old Value: %s" % old_value)
                print("New Value: %d element(s) written: %s" % (len(values), ", ".join(values)))
                print("SCRIPT_SUCCESS: Parameter array set. Project saved.")
            else:
                try:
                    found.value = NEW_VALUE
                except Exception as scalar_err:
                    if subs:
                        raise RuntimeError(
                            "Parameter '%s' rejected a scalar write (%s) and has %d sub-element(s). "
                            "Write it as an array literal value '[v0, v1, ...]' or one element at a time "
                            "with elementIndex." % (name, scalar_err, len(subs)))
                    raise
                primary_project.save()
                print("Device: %s" % dev_name)
                print("Scope: %s" % found_scope)
                print("Parameter: %s" % name)
                print("Old Value: %s" % old_value)
                print("New Value: %s" % NEW_VALUE)
                print("SCRIPT_SUCCESS: Parameter set. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error accessing device parameter in project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
