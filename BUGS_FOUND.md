# Bugs Found in wa-webhook-router

## Critical Bugs

### 1. Authorization Header Sends `undefined` Token

**Location**: `index.mjs:72`

**Issue**:

```javascript
'Authorization': `Bearer ${destino.token}`
```

The `destino` object only contains `{ url }` but the code tries to access `destino.token`, which is always `undefined`.

**Impact**: All forwarded requests send `Authorization: Bearer undefined` header, which will likely fail authentication at destination endpoints.

**Fix**: Either:

- Remove Authorization header if not needed
- Add token to PHONE_ROUTES format: `phone::url::token`
- Add separate TOKEN environment variable

### 2. URL Concatenation Creates Malformed URLs

**Location**: `index.mjs:54`

**Issue**:

```javascript
const url = path.startsWith('http') ? path : `${destinoHost}${path}`;
```

When `DESTINATION_HOST=https://example.com` and `path=webhook/path` (no leading slash), creates `https://example.comwebhook/path`.

**Impact**: Requests fail with invalid URL.

**Fix**: Add slash handling:

```javascript
const url = path.startsWith('http') 
    ? path 
    : `${destinoHost}${path.startsWith('/') ? '' : '/'}${path}`;
```

## Medium Priority Issues

### 3. Missing Challenge Validation

**Location**: `index.mjs:22`

**Issue**: When `hub.challenge` is missing, sends empty string response instead of rejecting.

**Impact**: Could accept invalid webhook verification requests.

**Fix**: Validate challenge exists:

```javascript
if (mode === 'subscribe' && tokensAutorizados.includes(token) && challenge) {
```

### 4. Split on `::` Doesn't Handle Multiple Separators

**Location**: `index.mjs:51`

**Issue**: `route.split('::')` on `phone::url::extra` creates 3-element array. Code only uses first 2, silently ignores rest.

**Impact**: Potential confusion, but currently harmless.

**Fix**: Add validation or use limit: `split('::', 2)`

## Edge Cases Handled Correctly

✓ Empty PHONE_ROUTES
✓ Empty payload
✓ Missing phone number in payload  
✓ Unrecognized phone number
✓ Network errors from axios
✓ No authorized tokens configured
✓ Phone numbers with whitespace (trimmed correctly)
✓ Null/empty entry arrays

## Test Coverage

Total tests: 23

- Basic functionality: 9 tests
- Edge cases & bugs: 14 tests
- All passing: ✓

## Recommendations

1. Fix Authorization header bug immediately
2. Fix URL concatenation bug
3. Add token support to PHONE_ROUTES or remove Authorization header
4. Add validation for challenge parameter
5. Consider adding request timeout configuration
6. Add logging for malformed configuration on startup
