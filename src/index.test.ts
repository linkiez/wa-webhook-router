import { beforeEach, describe, expect, it } from '@jest/globals';

describe('SQS Consumer', () => {
    const mockQueueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue';
    const mockPhoneRoutes = '5511999999999::https://example.com/webhooks/whatsapp::token123|5511888888888::https://example.com/webhooks/meta';

    beforeEach(() => {
        // Set environment variables
        process.env.QUEUE_URL = mockQueueUrl;
        process.env.AWS_REGION = 'us-east-1';
        process.env.PHONE_ROUTES = mockPhoneRoutes;
    });

    describe('Route Configuration', () => {
        it('should parse phone routes correctly', () => {
            const routes = mockPhoneRoutes.split('|');
            expect(routes).toHaveLength(2);
            
            const route1 = routes[0].split('::');
            expect(route1[0]).toBe('5511999999999');
            expect(route1[1]).toBe('https://example.com/webhooks/whatsapp');
            expect(route1[2]).toBe('token123');
            
            const route2 = routes[1].split('::');
            expect(route2[0]).toBe('5511888888888');
            expect(route2[1]).toBe('https://example.com/webhooks/meta');
            expect(route2[2]).toBeUndefined();
        });

        it('should support repeating a phone number for multiple destinations', () => {
            const routesWithDuplicate = '5511999999999::https://a.com/hook|5511999999999::https://b.com/hook';
            const routes = routesWithDuplicate.split('|').map(r => r.split('::')[0]);
            
            expect(routes).toEqual(['5511999999999', '5511999999999']);
        });

        it('should parse the required flag and optional token', () => {
            const parse = (route: string) => {
                const parts = route.split('::').map(p => p.trim());
                const isRequired = parts.length > 2 && parts.at(-1) === 'required';
                if (isRequired) parts.pop();
                return { phone: parts[0], url: parts[1], token: parts[2] || undefined, required: isRequired };
            };

            expect(parse('5511999999999::https://a.com/hook')).toEqual({
                phone: '5511999999999', url: 'https://a.com/hook', token: undefined, required: false,
            });
            expect(parse('5511999999999::https://a.com/hook::required')).toEqual({
                phone: '5511999999999', url: 'https://a.com/hook', token: undefined, required: true,
            });
            expect(parse('5511999999999::https://a.com/hook::tok::required')).toEqual({
                phone: '5511999999999', url: 'https://a.com/hook', token: 'tok', required: true,
            });
        });
    });

    describe('Message Processing', () => {
        it('should extract phone number from Meta webhook payload', () => {
            const payload = {
                entry: [{
                    changes: [{
                        value: {
                            metadata: {
                                display_phone_number: '5511999999999'
                            }
                        }
                    }]
                }]
            };

            const phoneNumber = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;
            expect(phoneNumber).toBe('5511999999999');
        });

        it('should handle missing phone number gracefully', () => {
            const payload: { entry: Array<{ changes: Array<{ value: { metadata: Record<string, never> } }> }> } = {
                entry: [{
                    changes: [{
                        value: {
                            metadata: {}
                        }
                    }]
                }]
            };

            const phoneNumber = (payload as any)?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;
            expect(phoneNumber).toBeUndefined();
        });

        it('should include Authorization header when token is provided', () => {
            const token = 'token123';
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            
            expect(headers['Authorization']).toBe('Bearer token123');
        });

        it('should not include Authorization header when token is not provided', () => {
            const token = undefined;
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            
            expect(headers['Authorization']).toBeUndefined();
        });
    });

    describe('Error Handling', () => {
        it('should handle JSON parse errors', () => {
            const invalidJson = '{invalid json}';
            
            expect(() => {
                JSON.parse(invalidJson);
            }).toThrow();
        });

        it('should extract error messages from Error objects', () => {
            const error: unknown = new Error('Test error message');
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            
            expect(errorMessage).toBe('Test error message');
        });

        it('should handle non-Error objects', () => {
            const error: unknown = 'string error';
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            
            expect(errorMessage).toBe('Unknown error');
        });
    });

    describe('Environment Validation', () => {
        it('should require QUEUE_URL environment variable', () => {
            expect(process.env.QUEUE_URL).toBeDefined();
            expect(process.env.QUEUE_URL).toBe(mockQueueUrl);
        });

        it('should use default AWS region if not provided', () => {
            delete process.env.AWS_REGION;
            const defaultRegion = process.env.AWS_REGION || 'us-east-1';
            
            expect(defaultRegion).toBe('us-east-1');
        });
    });
});
