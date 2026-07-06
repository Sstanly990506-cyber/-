"""Shared API route table for Flask, Vercel, and the built-in HTTP server."""

from api.service import (
    backup_payload,
    bootstrap_payload,
    capacity_payload,
    changes_payload,
    clear_test_data_payload,
    get_state_payload,
    health_payload,
    import_customers_payload,
    line_status_payload,
    optimize_trip_payload,
    pricing_quote_payload,
    recognize_order_payload,
    recognize_order_status_payload,
    report_order_correction_payload,
    report_payload,
    restore_backup_payload,
    send_line_payload,
    update_state_payload,
    user_action_payload,
)


def query_value(query, key, default=''):
    value = query.get(key, default)
    if isinstance(value, list):
        return value[0] if value else default
    return value if value is not None else default


GET_ROUTES = {
    '/api/health': lambda token, query: (health_payload, ()),
    '/health': lambda token, query: (health_payload, ()),
    '/api/bootstrap': lambda token, query: (bootstrap_payload, (token,)),
    '/api/state': lambda token, query: (get_state_payload, (token,)),
    '/state': lambda token, query: (get_state_payload, (token,)),
    '/api/admin/backup': lambda token, query: (backup_payload, (token,)),
    '/api/admin/capacity': lambda token, query: (capacity_payload, (token,)),
    '/api/changes': lambda token, query: (
        changes_payload,
        (token, query_value(query, 'since', '0'), query_value(query, 'limit', '1000')),
    ),
    '/api/reports/summary': lambda token, query: (report_payload, (token,)),
    '/api/orders/recognize/status': lambda token, query: (recognize_order_status_payload, (token,)),
    '/api/line/status': lambda token, query: (line_status_payload, (token,)),
}


POST_ROUTES = {
    '/api/state': lambda token, payload: (update_state_payload, (token, payload)),
    '/state': lambda token, payload: (update_state_payload, (token, payload)),
    '/api/users': lambda token, payload: (user_action_payload, (token, payload)),
    '/users': lambda token, payload: (user_action_payload, (token, payload)),
    '/api/admin/clear-test-data': lambda token, payload: (clear_test_data_payload, (token, payload)),
    '/api/admin/restore': lambda token, payload: (restore_backup_payload, (token, payload)),
    '/api/admin/import-customers': lambda token, payload: (import_customers_payload, (token, payload)),
    '/api/trips/optimize': lambda token, payload: (optimize_trip_payload, (token, payload)),
    '/trips/optimize': lambda token, payload: (optimize_trip_payload, (token, payload)),
    '/api/pricing/quote': lambda token, payload: (pricing_quote_payload, (token, payload)),
    '/api/line/push': lambda token, payload: (send_line_payload, (token, payload)),
    '/api/orders/recognize': lambda token, payload: (recognize_order_payload, (token, payload)),
    '/api/orders/recognize/corrections': lambda token, payload: (
        report_order_correction_payload,
        (token, payload),
    ),
}


def resolve_get_route(path, token, query):
    factory = GET_ROUTES.get(path)
    return factory(token, query) if factory else None


def resolve_post_route(path, token, payload):
    factory = POST_ROUTES.get(path)
    return factory(token, payload) if factory else None
