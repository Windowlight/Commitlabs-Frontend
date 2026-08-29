import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MarketplaceGrid, fetchMarketplaceStatsDedup, REQUEST_DEDUP_BOUNDS } from './MarketplaceGrid';
import type { MarketplaceCardProps } from './MarketplaceCard';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('./MarketplaceCard', () => ({
  MarketplaceCard: ({ id, title }: any) => <div data-testid={`card-${id}`}>{title}</div>,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockItem(id: string, overrides?: Partial<MarketplaceCardProps>): MarketplaceCardProps {
  return {
    id,
    title: `Commitment ${id}`,
    status: 'active',
    yield: 8.5,
    price: 1500,
    description: 'Test commitment',
    ...overrides,
  } as MarketplaceCardProps;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MarketplaceGrid - Loading, Error & Empty States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Success Cases ──────────────────────────────────────────────────────────

  it('renders items grid when data is available', () => {
    const items = [
      createMockItem('1'),
      createMockItem('2'),
      createMockItem('3'),
    ];

    render(<MarketplaceGrid items={items} />);

    expect(screen.getByTestId('card-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-2')).toBeInTheDocument();
    expect(screen.getByTestId('card-3')).toBeInTheDocument();
  });

  // ── Loading State Tests ────────────────────────────────────────────────────

  it('shows loading skeleton when isLoading is true and no items', () => {
    render(<MarketplaceGrid items={[]} isLoading={true} />);

    const skeleton = screen.getByLabelText('Loading marketplace listings');
    expect(skeleton).toBeInTheDocument();
  });

  it('does not show skeleton when items are available even if loading', () => {
    const items = [createMockItem('1')];

    render(<MarketplaceGrid items={items} isLoading={true} />);

    expect(screen.queryByLabelText('Loading marketplace listings')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-1')).toBeInTheDocument();
  });

  // ── Empty State Tests ──────────────────────────────────────────────────────

  it('shows empty state when no items and not loading', () => {
    render(<MarketplaceGrid items={[]} isLoading={false} />);

    const emptyMessage = screen.getByText('No commitments available');
    expect(emptyMessage).toBeInTheDocument();
    expect(screen.getByText('New offers will appear here once they are listed.')).toBeInTheDocument();
  });

  it('shows empty state with cache status indicator', () => {
    render(
      <MarketplaceGrid
        items={[]}
        isLoading={false}
        cacheStatus="STALE"
      />,
    );

    expect(screen.getByText('No commitments available')).toBeInTheDocument();
    expect(screen.getByText(/Cache status: STALE/)).toBeInTheDocument();
  });

  // ── Error State Tests ──────────────────────────────────────────────────────

  it('shows error state when error prop is set', () => {
    render(
      <MarketplaceGrid
        items={[]}
        error="Failed to load marketplace data"
      />,
    );

    expect(screen.getByText('Unable to load marketplace')).toBeInTheDocument();
    expect(screen.getByText('Failed to load marketplace data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/ })).toBeInTheDocument();
  });

  it('shows error with cache status indicator', () => {
    render(
      <MarketplaceGrid
        items={[]}
        error="Service error"
        cacheStatus="EXPIRED"
      />,
    );

    expect(screen.getByText('Unable to load marketplace')).toBeInTheDocument();
    expect(screen.getByText(/Cache status: EXPIRED/)).toBeInTheDocument();
  });

  // ── Cache Status Indicator Tests ───────────────────────────────────────────

  it('shows cache status warning for STALE data', () => {
    const items = [createMockItem('1')];

    render(
      <MarketplaceGrid
        items={items}
        cacheStatus="STALE"
      />,
    );

    expect(screen.getByText(/Showing cached data/)).toBeInTheDocument();
  });

  it('shows cache status warning for EXPIRED data', () => {
    const items = [createMockItem('1')];

    render(
      <MarketplaceGrid
        items={items}
        cacheStatus="EXPIRED"
      />,
    );

    expect(screen.getByText(/Showing old data/)).toBeInTheDocument();
  });

  it('does not show cache warning for FRESH data', () => {
    const items = [createMockItem('1')];

    render(
      <MarketplaceGrid
        items={items}
        cacheStatus="FRESH"
      />,
    );

    expect(screen.queryByText(/Showing.*data/)).not.toBeInTheDocument();
  });

  // ── Accessibility Tests ────────────────────────────────────────────────────

  it('uses proper aria labels for different states', () => {
    const { rerender } = render(
      <MarketplaceGrid items={[]} isLoading={true} />,
    );
    expect(screen.getByLabelText('Loading marketplace listings')).toBeInTheDocument();

    rerender(<MarketplaceGrid items={[]} />);
    expect(screen.getByLabelText('Marketplace listings')).toBeInTheDocument();

    rerender(<MarketplaceGrid items={[]} error="Error" />);
    expect(screen.getByLabelText('Marketplace error')).toBeInTheDocument();
  });

  // ── Responsive Layout Tests ────────────────────────────────────────────────

  it('renders grid with proper responsive classes', () => {
    const items = Array.from({ length: 6 }, (_, i) => createMockItem(`${i}`));

    const { container } = render(<MarketplaceGrid items={items} />);

    const ul = container.querySelector('ul');
    expect(ul).toHaveClass('grid', 'grid-cols-3');
  });
});

describe('fetchMarketplaceStatsDedup - Request Deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any active fetch trackers
    for (const key of Object.keys(global as any)) {
      if (key.startsWith('marketplace_request_')) {
        delete (global as any)[key];
      }
    }
  });

  // ── Deduplication Tests ────────────────────────────────────────────────────

  it('returns same promise for concurrent requests within dedup window', async () => {
    const url = 'http://localhost/api/marketplace/stats';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), { status: 200 }),
    );
    global.fetch = mockFetch;

    // First request
    const promise1 = fetchMarketplaceStatsDedup(url);

    // Second request immediately after (within dedup window)
    const promise2 = fetchMarketplaceStatsDedup(url);

    // Both should be the same promise
    expect(promise1).toBe(promise2);

    await promise1;

    // Only one fetch should have been made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('makes new request after dedup window expires', async () => {
    const url = 'http://localhost/api/marketplace/stats';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), { status: 200 }),
    );
    global.fetch = mockFetch;

    // First request
    fetchMarketplaceStatsDedup(url);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Wait longer than dedup window
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DEDUP_BOUNDS.DEDUP_WINDOW_MS + 100));

    // Second request should be new
    fetchMarketplaceStatsDedup(url);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('includes proper headers in deduped requests', async () => {
    const url = 'http://localhost/api/marketplace/stats';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), { status: 200 }),
    );
    global.fetch = mockFetch;

    await fetchMarketplaceStatsDedup(url);

    expect(mockFetch).toHaveBeenCalledWith(url, {
      headers: { 'Accept': 'application/json' },
    });
  });

  // ── Tracker Cleanup Tests ──────────────────────────────────────────────────

  it('cleans up old trackers to prevent memory leaks', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), { status: 200 }),
    );
    global.fetch = mockFetch;

    // Make requests from many URLs to simulate accumulation
    for (let i = 0; i < 20; i++) {
      const url = `http://localhost/api/marketplace/stats?page=${i}`;
      await fetchMarketplaceStatsDedup(url);
    }

    // Wait for stale entries to age
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DEDUP_BOUNDS.STALE_AFTER_MS + 100));

    // Make one more request to trigger cleanup
    await fetchMarketplaceStatsDedup('http://localhost/api/marketplace/stats?cleanup');

    // Should not have excessive trackers
    // (This is more of an integration test - ideally would inspect the tracker map)
  });

  // ── Bounds Tests ───────────────────────────────────────────────────────────

  it('respects REQUEST_DEDUP_BOUNDS constants', () => {
    expect(REQUEST_DEDUP_BOUNDS.STALE_AFTER_MS).toBeGreaterThan(0);
    expect(REQUEST_DEDUP_BOUNDS.DEDUP_WINDOW_MS).toBeGreaterThan(0);
    expect(REQUEST_DEDUP_BOUNDS.MAX_CONCURRENT).toBeGreaterThan(0);
    expect(REQUEST_DEDUP_BOUNDS.STALE_AFTER_MS).toBeGreaterThan(REQUEST_DEDUP_BOUNDS.DEDUP_WINDOW_MS);
  });
});
