"""Non-secret configuration and conservative text screening shared by both sides."""
import re

SITE_ORIGIN = 'https://omega-ten-20.vercel.app'
COMPANION_ORIGIN = 'http://127.0.0.1:4175'
PATTERNS = tuple(re.compile(pattern, re.I | re.M) for pattern in (
    r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    r'\bDATABASE_URL\s*[:=]',
    r'\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://\S+',
    r'\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S+',
    r'\bAKIA[0-9A-Z]{16}\b', r'\bgh[pousr]_[A-Za-z0-9]{20,}\b', r'\bsk-[A-Za-z0-9_-]{20,}\b',
))


def contains_secret(text):
    return isinstance(text, str) and any(pattern.search(text) for pattern in PATTERNS)
