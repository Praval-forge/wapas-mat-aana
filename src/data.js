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

// 40 synthetic demo orders (34 COD / 6 prepaid). Names, phones and addresses are
// invented; phones use the 98100001xx placeholder range. No real personal data.
// The first five are the original v1 cases and keep stable ids CG-1001..CG-1005:
//  CG-1001 full address, safe pin, loyal buyer        -> LOW (score 0)
//  CG-1002 vague address ("Near temple, Hyd")          -> MEDIUM (free YES confirmation)
//  CG-1003 buyer with 2 past returns                   -> HIGH (Rs 49 upfront)
//  CG-1004 good address but high-return pin            -> MEDIUM
//  CG-1005 seller asks for a city-wide block           -> request REFUSED; scored on its own signals (LOW)
// The remaining 35 supply their own synthetic history and cover every band
// (LOW, MEDIUM, HIGH, VERY_HIGH, EXTREME), same-phone escalation within one IST
// day, a fake-looking order and prepaid orders. Every order waits for a human.
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
  { buyer_name: 'Ananya Iyer', phone: '9810000106', pin: '600042', city: 'Chennai', address: 'Flat 3B, Lotus Apartments, 4th Main Road, Velachery, Chennai 600042', product: 'Cotton kurta', amount: 799, payment_mode: 'cod', past_orders: 3, past_returns: 0 },
  { buyer_name: 'Vikram Singh', phone: '9810000107', pin: '110001', city: 'Delhi', address: 'House 12, Lane 5, Connaught Place, New Delhi 110001', product: 'Linen shirt', amount: 1299, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Meera Pillai', phone: '9810000108', pin: '400001', city: 'Mumbai', address: 'Flat 1201, Sea View Apartments, Fort, Mumbai 400001', product: 'Silk saree', amount: 2999, payment_mode: 'cod', past_orders: 4, past_returns: 0 },
  { buyer_name: 'Arjun Rao', phone: '9810000109', pin: '500081', city: 'Hyderabad', address: 'Plot 44, Sector 2, Madhapur, Hyderabad 500081', product: 'Nehru jacket', amount: 1899, payment_mode: 'cod', past_orders: 2, past_returns: 0 },
  { buyer_name: 'Kavya Menon', phone: '9810000110', pin: '700091', city: 'Kolkata', address: 'Flat 7, Salt Lake Sector 1, Kolkata 700091', product: 'Palazzo pants', amount: 899, payment_mode: 'cod', past_orders: 1, past_returns: 0 },
  { buyer_name: 'Rahul Gupta', phone: '9810000111', pin: '302001', city: 'Jaipur', address: 'House 9, MI Road, near Raj Mandir, Jaipur 302001', product: 'Block-print dupatta', amount: 599, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Neha Joshi', phone: '9810000112', pin: '411045', city: 'Pune', address: 'Flat 22, Baner Road, Pune 411045 near Balewadi', product: 'Chikankari top', amount: 1499, payment_mode: 'cod', past_orders: 5, past_returns: 1 },
  { buyer_name: 'Sanjay Kumar', phone: '9810000113', pin: '122018', city: 'Gurugram', address: 'House 15, Sector 14, Gurugram 122018', product: 'Denim jacket', amount: 2499, payment_mode: 'cod', past_orders: 3, past_returns: 0 },
  { buyer_name: 'Pooja Sharma', phone: '9810000114', pin: '201301', city: 'Noida', address: 'Flat 404, Sector 18, Noida 201301', product: 'Kids ethnic set', amount: 999, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Imran Qureshi', phone: '9810000115', pin: '560034', city: 'Bengaluru', address: 'Near Forum Mall, Koramangala', product: 'Linen shirt', amount: 1299, payment_mode: 'cod', past_orders: 1, past_returns: 0 },
  { buyer_name: 'Divya Nair', phone: '9810000116', pin: '682001', city: 'Kochi', address: 'B-14, MG Road, Ernakulam, Kochi 682001', product: 'Cotton kurta', amount: 799, payment_mode: 'cod', past_orders: 1, past_returns: 0 },
  { buyer_name: 'Harish Reddy', phone: '9810000117', pin: '110096', city: 'Delhi', address: 'H.No 8, Gali 2, Shahdara, Delhi 110096', product: 'Palazzo pants', amount: 899, payment_mode: 'cod', past_orders: 2, past_returns: 0 },
  { buyer_name: 'Lakshmi Devi', phone: '9810000118', pin: '421302', city: 'Bhiwandi', address: 'Room 5, Shiv Chawl, near station, Bhiwandi 421302', product: 'Silk saree', amount: 2999, payment_mode: 'cod', past_orders: 1, past_returns: 0 },
  { buyer_name: 'Farhan Ali', phone: '9810000119', pin: '800001', city: 'Patna', address: 'Near Gandhi Maidan, Patna', product: 'Nehru jacket', amount: 1899, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Rohan Das', phone: '9810000120', pin: '201010', city: 'Ghaziabad', address: 'Flat 9C, Indirapuram, Ghaziabad 201010', product: 'Denim jacket', amount: 2499, payment_mode: 'cod', past_orders: 3, past_returns: 1 },
  { buyer_name: 'Sunita Yadav', phone: '9810000121', pin: '110093', city: 'Delhi', address: 'Near water tank, Seemapuri', product: 'Kids ethnic set', amount: 999, payment_mode: 'cod', past_orders: 2, past_returns: 1 },
  { buyer_name: 'Manoj Tiwari', phone: '9810000122', pin: '800001', city: 'Patna', address: 'Near bus stand, Patna', product: 'Chikankari top', amount: 1499, payment_mode: 'cod', past_orders: 4, past_returns: 2 },
  { buyer_name: 'Asha Kaur', phone: '9810000123', pin: '110096', city: 'Delhi', address: 'Shahdara', product: 'Silk saree', amount: 2999, payment_mode: 'cod', past_orders: 6, past_returns: 3 },
  { buyer_name: 'Xyz', phone: '9999999999', pin: '421302', city: 'Bhiwandi', address: 'abc', product: 'Denim jacket', amount: 2499, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Kiran Patil', phone: '9810000125', pin: '122018', city: 'Gurugram', address: 'House 3, Sector 14, Gurugram 122018', product: 'Silk saree', amount: 2999, payment_mode: 'cod', past_orders: 2, past_returns: 2 },
  { buyer_name: 'Gaurav Mishra', phone: '9810000126', pin: '201301', city: 'Noida', address: 'Sector 62, Noida', product: 'Denim jacket', amount: 2499, payment_mode: 'cod', past_orders: 1, past_returns: 1 },
  { buyer_name: 'Ritu Bansal', phone: '9810000127', pin: '110093', city: 'Delhi', address: 'Flat 2, Lane 4, Seemapuri, Delhi 110093', product: 'Nehru jacket', amount: 1899, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Deepak Verma', phone: '9810000128', pin: '500081', city: 'Hyderabad', address: 'Flat 5, Sector 3, Madhapur, Hyderabad 500081', product: 'Palazzo pants', amount: 899, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Deepak Verma', phone: '9810000128', pin: '500081', city: 'Hyderabad', address: 'Flat 5, Sector 3, Madhapur, Hyderabad 500081', product: 'Cotton kurta', amount: 799, payment_mode: 'cod', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Nikhil Jain', phone: '9810000130', pin: '700091', city: 'Kolkata', address: 'Near metro, Salt Lake', product: 'Denim jacket', amount: 2499, payment_mode: 'cod', past_orders: 1, past_returns: 1 },
  { buyer_name: 'Nikhil Jain', phone: '9810000130', pin: '700091', city: 'Kolkata', address: 'Near metro, Salt Lake', product: 'Linen shirt', amount: 1299, payment_mode: 'cod', past_orders: 1, past_returns: 1 },
  { buyer_name: 'Nikhil Jain', phone: '9810000130', pin: '700091', city: 'Kolkata', address: 'Near metro, Salt Lake', product: 'Kids ethnic set', amount: 999, payment_mode: 'cod', past_orders: 1, past_returns: 1 },
  { buyer_name: 'Shreya Kapoor', phone: '9810000133', pin: '560034', city: 'Bengaluru', address: 'Flat 8, Rose Apartments, Koramangala, Bengaluru 560034', product: 'Chikankari top', amount: 1499, payment_mode: 'prepaid', past_orders: 2, past_returns: 0 },
  { buyer_name: 'Aditya Bose', phone: '9810000134', pin: '700091', city: 'Kolkata', address: 'Flat 3, Salt Lake Sector 2, Kolkata 700091', product: 'Silk saree', amount: 2999, payment_mode: 'prepaid', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Fatima Shaikh', phone: '9810000135', pin: '421302', city: 'Bhiwandi', address: 'Near station, Bhiwandi', product: 'Palazzo pants', amount: 899, payment_mode: 'prepaid', past_orders: 1, past_returns: 0 },
  { buyer_name: 'Ishaan Malhotra', phone: '9810000136', pin: '110001', city: 'Delhi', address: 'House 4, Lane 2, Connaught Place, New Delhi 110001', product: 'Linen shirt', amount: 1299, payment_mode: 'prepaid', past_orders: 5, past_returns: 0 },
  { buyer_name: 'Nandini Rao', phone: '9810000137', pin: '600042', city: 'Chennai', address: 'Flat 1A, Velachery Main Road, Chennai 600042', product: 'Block-print dupatta', amount: 599, payment_mode: 'prepaid', past_orders: 0, past_returns: 0 },
  { buyer_name: 'Varun Chopra', phone: '9810000138', pin: '400001', city: 'Mumbai', address: 'Flat 6, Marine Apartments, Fort, Mumbai 400001', product: 'Denim jacket', amount: 2499, payment_mode: 'prepaid', past_orders: 3, past_returns: 0 },
  { buyer_name: 'Prakash Naidu', phone: '9810000139', pin: '411045', city: 'Pune', address: 'Flat 11, Lane 7, Baner, Pune 411045', product: 'Linen shirt', amount: 1299, payment_mode: 'cod', past_orders: 8, past_returns: 1 },
  { buyer_name: 'Zoya Khan', phone: '9810000140', pin: '380015', city: 'Ahmedabad', address: 'Near temple, Satellite', product: 'Silk saree', amount: 2999, payment_mode: 'cod', past_orders: 2, past_returns: 1 },
];
