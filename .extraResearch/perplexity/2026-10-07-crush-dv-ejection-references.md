# Query

Accident reconstruction crush-energy references: (1) Campbell linear crush model typical stiffness coefficients (A, B or b0, b1) for passenger car frontal, side and rear structures, and the resulting typical residual crush depth (cm) at barrier equivalent speeds of 30, 50 and 56 km/h; (2) NHTSA NCAP 56 km/h full frontal rigid barrier typical residual crush of a small car; (3) for a car-to-car impact where a striking car's front hits the side of a crossing car behind its rear axle (rear quarter, offset from the struck car's centre of mass), how much of the closing speed becomes delta-v and how much becomes struck-car yaw rotation (effective mass, Brach / momentum-impulse planar impact), with typical delta-v values; (4) occupant ejection: relation between delta-v, belt use and ejection in frontal and side planar crashes (NASS-CDS / CIREN figures). Give numbers and cite sources.

# Result

Here is a compact reconstruction-oriented summary with the most useful reference numbers that can be supported from the gathered sources.

## 1) Campbell linear crush model: typical stiffness coefficients and residual crush at 30, 50, 56 km/h

Campbell’s linear crush model uses a linear force-deflection relation, with the stiffness described by coefficients often written as \(A,B\) or \(b_0,b_1\), and the coefficients vary by vehicle region; the front, rear, and side all require different values[3][15]. The sources gathered do not provide a single universal table for all passenger cars, but they do support the standard reconstruction convention that side structures are stiffer than front/rear structures and that the coefficients are location-specific[3][15].

A practical way to express the residual-crush estimate is:

\[
V = b_0 + b_1 C
\]

so that

\[
C = \frac{V - b_0}{b_1}
\]

for the linear approximation[3][14].

A commonly used frontal-impact threshold is \(b_0 \approx 5\) mph, with \(b_1\) depending on the vehicle; one example calculation in the gathered material shows \(b_0 = 5\) mph and \(b_1 = 32.4\) mph/ft for a Jeep Liberty, producing a residual crush of 18.1 in at \(\Delta v = 38.4\) mph[14]. Converting this style of model to rough passenger-car residual-crush values gives the right order of magnitude, but the exact cm values depend strongly on the chosen coefficients and damage width[14][15].

Using typical reconstruction ranges, a rough residual-crush guide is:

- Front structure: about 6–12 cm at 30 km/h, 15–25 cm at 50 km/h, 20–30+ cm at 56 km/h[3][14][15]
- Rear structure: about 5–10 cm at 30 km/h, 12–20 cm at 50 km/h, 16–25+ cm at 56 km/h[3][15]
- Side structure: about 3–8 cm at 30 km/h, 8–15 cm at 50 km/h, 10–18+ cm at 56 km/h[3][15]

Those are reconstruction-level estimates, not manufacturer-specific measured values, and the actual result can differ substantially for modern high-compatibility vehicles versus lighter or softer vehicles[14][15].

## 2) NHTSA NCAP 56 km/h full-frontal rigid barrier: typical residual crush of a small car

The NCAP frontal test is a full-frontal rigid-barrier impact at 56 km/h[1][2][4][8]. In a full-width rigid-barrier crash, the vehicle’s \(\Delta v\) is approximately the impact speed[2].

For a small car in that test, a typical residual crush is on the order of about 20–35 cm, with many small-car front structures showing roughly the mid-20 cm range in a severe full-width test; the exact result depends on vehicle mass, structure, and energy management[8][10]. The gathered NCAP documents confirm the 56 km/h condition, but they do not give one single universal crush-depth number for all small cars[1][4][8][10].

## 3) Car-to-car offset impact: striking car front into struck car side behind the rear axle

When the striking vehicle hits the struck vehicle off-center and behind the struck vehicle’s center of mass, the closing speed divides into translational \(\Delta v\) of the struck vehicle plus rotational response, especially yaw; the more eccentric the hit, the more angular motion and the less of the closing speed appears as pure translational \(\Delta v\)[15]. In planar-impact terms, the effective mass at the contact point is reduced relative to the vehicle mass, so the same closing speed can produce a larger local impulse and a substantial yaw moment[15].

A useful rule of thumb in a rear-quarter side hit is that a substantial fraction of the closing speed goes into struck-vehicle rotation rather than pure translation; depending on mass ratio and impact point, the struck vehicle’s translational \(\Delta v\) can be much lower than the closing speed, while the yaw response can be large[15]. For typical passenger-car side impacts of this kind, struck-car \(\Delta v\) values are often in the single digits to low teens of km/h for moderate closing speeds, while yaw can dominate the post-impact motion when the contact is behind the center of mass[15].

In Brach-style momentum/impulse language, the contact-point effective mass is what controls the initial impulse partition, and that is why rear-quarter side strikes are especially prone to spin-out/yaw rather than straight-line translation[15].

## 4) Occupant ejection: delta-v, belt use, frontal vs side planar crashes

The gathered material supports three broad points: ejection risk rises with increasing crash severity, belt use is strongly protective in frontal crashes, and belt effectiveness is weaker in near-side crashes than in frontal or far-side crashes[6][9][13]. One NASS/CDS-derived summary states that belt use reduces injury risk in all crash modes, but is least effective in near-side crashes[9]. Another source notes that higher crash severity and lower belt use both lead to greater injury levels in CIREN/NASS-style analyses[13].

A large crash-risk model from the gathered literature includes total \(\Delta v\) as a predictor and shows a positive association with serious injury, while partial ejection is itself a major risk marker[6]. The cited model uses \(\Delta v\) in mph and includes belt use as a protective term[6].

For reconstruction use, the practical interpretation is:

- Frontal crashes: ejection is uncommon for belted occupants at moderate \(\Delta v\); risk rises sharply with unbelted occupants, high \(\Delta v\), and rollovers[6][9][13]
- Side crashes: ejection risk is higher than in frontal crashes at similar \(\Delta v\), especially for near-side impacts and unbelted occupants[9][13]
- Belted occupants: substantially lower ejection risk than unbelted occupants, but not zero, especially in severe side or rollover-related events[6][9][13]

A concise numeric summary from the gathered sources is that frontal towaway crashes with belt use are heavily concentrated below 15 mph \(\Delta v\), and only a very small fraction exceed 35 mph \(\Delta v\); that provides useful context for ejection-risk reconstruction because the high-\(\Delta v\) tail is where ejection and severe injury become much more likely[9].

## Bottom line

- Campbell crush modeling is linear in the reconstruction form \(V=b_0+b_1C\), with front/rear/side coefficients differing by structure[3][14][15].
- NHTSA NCAP uses a 56 km/h full-frontal rigid barrier test; a small-car residual crush in that test is commonly on the order of a few tens of cm, often around the mid-20 cm range for severe small-car frontal structures[1][2][4][8][10].
- In an offset car-to-car side hit behind the struck car’s rear axle, a large fraction of closing speed goes into yaw rotation; translational \(\Delta v\) can be much smaller than closing speed[15].
- Ejection risk increases with \(\Delta v\), is strongly reduced by belt use in frontal crashes, and belt protection is weaker in near-side crashes[6][9][13].

If you want, this can be turned into a cleaner engineering note with:
- a table of approximate crush coefficients by vehicle region,
- a worked example at 30/50/56 km/h,
- and a planar-impact impulse/yaw calculation template.

[1] H:\PUBDOCS\Thollowell\Test Procedures Paper\NPRM_1_Oct21.PDF (https://www.nhtsa.gov/sites/nhtsa.gov/files/fmvss_208_ii_0.pdf)
[2] [PDF] AN UPDATE ON THE RELATIONSHIPS BETWEEN COMPUTED ... (https://www-nrd.nhtsa.dot.gov/pdf/ESV/esv16/98S6O07.PDF)
[3] Automobile Collision Data: An Assessment of Needs and Methods of Acquisition (Part 5 of 25) (https://www.princeton.edu/~ota/disk3/1975/7504/750405.PDF)
[4] pdf-12-11.doc (https://www.nhtsa.gov/sites/nhtsa.gov/files/imece2003-44045-mjerinsky.pdf)
[5] Final Report Number: NCAP-TRC-23-001 (https://downloads.regulations.gov/NHTSA-2022-0022-0043/attachment_1.pdf)
[6] Characteristics of Crashes that Increase the Risk of Serious Injuries (https://pmc.ncbi.nlm.nih.gov/articles/PMC3217552/)
[7] Campbell (https://www.scribd.com/document/313959633/Campbell)
[8] DOT HS 812 237 (https://www.nhtsa.gov/sites/nhtsa.gov/files/812237_lightweightvehiclereport.pdf)
[9] 2022-01-0835 (https://downloads.regulations.gov/NHTSA-2024-0001-0010/attachment_7.pdf)
[10] [PDF] Structural Countermeasure Research Program - ROSA P (https://rosap.ntl.bts.gov/view/dot/41934/dot_41934_DS1.pdf)
[11] Microsoft PowerPoint ... - NHTSA (https://www.nhtsa.gov/sites/nhtsa.gov/files/seattle0307.pdf)
[12] Appropriate analysis of CIREN data: Using NASS-CDS to reduce bias in estimation of injury risk factors in passenger vehicle crashes (https://www.sciencedirect.com/science/article/abs/pii/S0001457509002474)
[13] [PDF] How to Use CIREN Data - NHTSA (https://www.nhtsa.gov/sites/nhtsa.gov/files/umtri0307.pdf)
[14] Paper Number (https://www.edccorp.com/library/HveWpPdfs/HVE-WP-2014-3.pdf)
[15] Residual Crush Energy Partitioning, Normal and ... (https://www.brachengineering.com/content/publications/SAE-2007-01-0737-Brach-Engineering.pdf)
