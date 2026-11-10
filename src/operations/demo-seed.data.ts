export const DEMO_PASSWORD = 'Demo-Password-12345';

export const DEMO_DIVISIONS = [
  { code: 'DEMO-HR', name: 'Human Resources', position: 'HR Administrator' },
  { code: 'DEMO-ENG', name: 'Engineering', position: 'Software Engineer' },
  { code: 'DEMO-OPS', name: 'Operations', position: 'Operations Specialist' },
  { code: 'DEMO-FIN', name: 'Finance', position: 'Finance Officer' },
  { code: 'DEMO-SALES', name: 'Sales', position: 'Sales Executive' },
  {
    code: 'DEMO-SUPPORT',
    name: 'Customer Support',
    position: 'Support Specialist',
  },
] as const;

const names = [
  'Ayu Pratama',
  'Bima Saputra',
  'Citra Lestari',
  'Dimas Wijaya',
  'Eka Putri',
  'Farhan Hidayat',
  'Gita Permata',
  'Hendra Kurniawan',
  'Indah Sari',
  'Joko Santoso',
  'Kartika Dewi',
  'Lukman Hakim',
  'Maya Anggraini',
  'Nanda Setiawan',
  'Olivia Maharani',
  'Prasetyo Nugroho',
  'Qori Azzahra',
  'Rizky Ramadhan',
  'Sinta Wulandari',
  'Taufik Akbar',
  'Utami Pertiwi',
  'Vino Firmansyah',
  'Wulan Puspita',
  'Yoga Saputra',
  'Zahra Amalia',
  'Aditya Pranata',
  'Bella Safitri',
  'Chandra Gunawan',
  'Dewi Larasati',
  'Eko Susanto',
  'Fitri Handayani',
  'Galih Wicaksono',
  'Hana Rahmawati',
  'Irfan Maulana',
  'Jasmine Aulia',
  'Kevin Hermawan',
  'Laila Nuraini',
  'Muhammad Fajar',
  'Nadia Oktaviani',
  'Oscar Hartono',
];

export const DEMO_PEOPLE = names.map((fullName, index) => {
  const hr = index < 4;
  const number = hr ? index + 1 : index - 3;
  const division = DEMO_DIVISIONS[hr ? 0 : 1 + ((index - 4) % 5)];

  return {
    fullName,
    email: `demo.${hr ? 'hr' : 'employee'}${String(number).padStart(2, '0')}@example.test`,
    role: hr ? ('HRD' as const) : ('EMPLOYEE' as const),
    divisionCode: division.code,
    positionCode: `${division.code}-STAFF`,
  };
});
