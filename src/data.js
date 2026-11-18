// Illustrative demo data. In production, build both tables from the seller's own
// order/return history (e.g. a nightly Shopify export) - nothing here is real statistics.

// Pin-code table: observed COD return rate and sample size per pin code.
export const PIN_TABLE = {
  '110001': { area: 'Connaught Place, Delhi', returnRate: 0.14, orders: 620 },
  '400001': { area: 'Fort, Mumbai', returnRate: 0.16, orders: 710 },
  '560034': { area: 'Koramangala, Bengaluru', returnRate: 0.17, orders: 840 },
  '600042': { area: 'Velachery, Chennai', returnRate: 0.19, orders: 460 },
  '411045': { area: 'Baner, Pune', returnRate: 0.2, orders: 390 },
  '500081': { area: 'Madhapur, Hyderabad', returnRate: 0.21, orders: 530 },
  '302001': { area: 'Jaipur city', returnRate: 0.22, orders: 350 },
  '700091': { area: 'Salt Lake, Kolkata', returnRate: 0.24, orders: 300 },
  '122018': { area: 'Sector 14, Gurugram', returnRate: 0.33, orders: 280 },
  '201301': { area: 'Sector 18, Noida', returnRate: 0.31, orders: 410 },
  '110096': { area: 'Shahdara, East Delhi', returnRate: 0.52, orders: 260 },
  '201010': { area: 'Indirapuram, Ghaziabad', returnRate: 0.49, orders: 330 },
  '421302': { area: 'Bhiwandi', returnRate: 0.51, orders: 220 },
  '800001': { area: 'Patna GPO', returnRate: 0.47, orders: 240 },
  '110093': { area: 'Seemapuri, Delhi', returnRate: 0.55, orders: 190 },
};

// Thresholds used by the pin check (plain code).
export const PIN_THRESHOLDS = {
  high: 0.45, // return rate >= 45%  -> high
  medium: 0.3, // return rate >= 30%  -> medium
  minSample: 30, // fewer orders than this -> "unknown" (not enough data, treated neutrally)
};

// Known buyers (looked up by phone). Unknown phone = new buyer with no history.
export const BUYER_HISTORY = {
  '9810000001': { past_orders: 6, past_returns: 0 },
  '9810000002': { past_orders: 1, past_returns: 0 },
  '9810000003': { past_orders: 5, past_returns: 2 },
  '9810000004': { past_orders: 2, past_returns: 0 },
  '9810000005': { past_orders: 0, past_returns: 0 },
  '9810000006': { past_orders: 8, past_returns: 1 },
};

export const RETURN_COST_RS = 350; // approx. cost of one returned COD order (shipping both ways + handling)
export const COMMITMENT_FEE_RS = 50;

// The five demo orders. Cases:
//  1 full address, safe pin, no returns          -> LOW, ships automatically
//  2 vague address ("Near temple, Hyd")          -> HIGH
//  3 buyer with 2 past returns                   -> HIGH
//  4 good address but high-return pin            -> MEDIUM, confirm only
//  5 city-wide block requested by the seller     -> request REFUSED; order scored on its own signals
export const SEED_ORDERS = [
  {
    buyer_name: 'Aarav Mehta',
    phone: '9810000001',
    pin: '560034',
    city: 'Bengaluru',
    address:
      'Flat 402, Sunrise Apartments, 5th Cross, 80 Feet Road, Koramangala, Bengaluru - 560034 (opposite Forum Mall)',
    product: 'Linen shirt (M)',
    amount: 1200,
  },
  {
    buyer_name: 'Sneha Reddy',
    phone: '9810000002',
    pin: '500081',
    city: 'Hyderabad',
    address: 'Near temple, Hyd',
    product: 'Kurta set (L)',
    amount: 1450,
  },
  {
    buyer_name: 'Rohit Verma',
    phone: '9810000003',
    pin: '411045',
    city: 'Pune',
    address: 'House 17, Lane 3, Baner Road, Baner, Pune 411045, near Balewadi High Street',
    product: 'Running shoes (9)',
    amount: 1899,
  },
  {
    buyer_name: 'Priya Nair',
    phone: '9810000004',
    pin: '110096',
    city: 'Delhi',
    address: 'H.No 23, Gali No 4, Shahdara Main Road, Shahdara, Delhi 110096, near Metro pillar 14',
    product: 'Handbag',
    amount: 1250,
  },
  {
    buyer_name: 'Kabir Singh',
    phone: '9810000005',
    pin: '302001',
    city: 'Jaipur',
    address: 'Flat 12, Gandhi Apartments, MI Road, C-Scheme, Jaipur 302001, landmark: Raj Mandir Cinema',
    product: 'Bluetooth speaker',
    amount: 1100,
    seller_request: 'Block all COD buyers from Jaipur',
  },
];
