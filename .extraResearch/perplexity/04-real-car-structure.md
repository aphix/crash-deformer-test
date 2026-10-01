For simulation tuning, a useful **starting point** for a modern sedan is: front longitudinal rails/crash boxes designed to carry roughly **tens to low hundreds of kN** in a controlled progressive collapse, with the bumper beam/load path initiating the fold and the rail crash boxes stabilizing the force plateau; a roof strength-to-weight ratio of about **4 or higher** for a “good” result; and a torsional stiffness often in the **20,000–40,000 Nm/deg** range for mainstream modern sedans, with higher values for premium or performance cars.[13][1][8]

## Practical tuning values
- **Front rails / crash boxes:** progressive folding, with a target crush-force plateau commonly around **40–70 kN per rail/load path** for realistic passenger-car structure tuning; some published crash-box examples report **mean crush forces around 33–65 kN** and design targets around **70 kN** over short crush strokes.[8][6]
- **Bumper beam:** usually the first member to engage, mainly to distribute load and trigger the crash boxes rather than absorb the whole event itself.[1][5]
- **Frontal crush distance:** for full-width rigid-barrier style events at **56 km/h**, a modern passenger car may need on the order of **400–600 mm** of managed crush space; the IIHS-style **64 km/h 40% overlap** test is more about asymmetric load paths and intrusion control than a single global crush number.[2][13]
- **Engine block:** commonly modeled as a **non-crushable mass** or very stiff lumped mass that redirects load into the rails and substructure rather than deforming significantly.
- **Firewall / toe board / A-pillar intrusion:** these should be held to very small intrusion in a good design; a practical simulation target is **minimal intrusion into the occupant cell**, with A-pillar and footwell deformation kept near zero or within only small, clearly bounded millimeter-scale excursions.
- **Side impact at 50 km/h MDB:** the key outputs are **B-pillar, sill, and door intrusion** rather than crush force; for a good sedan, side structure should limit intrusion enough to preserve occupant survival space, with B-pillar and door intrusion kept low and locally controlled.
- **Roof crush:** IIHS uses roof strength-to-weight ratio, and **4× vehicle weight or better** is the common benchmark for a strong roof structure.[13]
- **Rear crush:** usually tuned to absorb low- to moderate-severity rear impacts with a shorter crush stroke than the front, often using weaker rear rails/crash cans and bumper absorbers than the front.
- **Detaching parts:** in realistic crashes, **bumper covers, grilles, mirrors, hood latch hardware, some hood edges, and wheel/suspension components** may detach or become displaced; **doors** may partially open, jam, or be forced out of alignment depending on load path and intrusion.
- **Crumple zone vs safety cell stiffness:** the **crumple zone should be much softer** than the occupant cell; a common design intent is that the front/rear crush structures have a **much lower effective stiffness** than the passenger compartment, often roughly **an order of magnitude lower or more**, so energy is absorbed before the safety cell starts to deform.

## How to use these numbers in a model
- Use the **bumper beam + crash box + rail** as a staged force-displacement system, with an initial trigger, then a stable plateau, then rising force near end stroke.[1][6]
- Treat the **engine/powertrain** as a rigid or nearly rigid obstacle that shifts load into the rails and subframe.
- Set the **occupant cell** to remain significantly stiffer than the crush zone, so most deformation happens forward of the firewall.
- For **64 km/h offset**, prioritize **asymmetric rail engagement, load-path transfer, and cabin intrusion metrics** over simply matching one peak force value.[13][15]

If you want, this can be turned into a **numerical crash model template** with example force-displacement curves, intrusion targets, and section-by-section stiffness values for front, side, and rear.

[1] http://iaeme.com/Home/journal/IJMET (https://iaeme.com/MasterAdmin/Journal_uploads/IJMET/VOLUME_9_ISSUE_9/IJMET_09_09_092.pdf)
[2] How Crashworthiness Engineering Saves Lives Before Airbags ... (https://www.linkedin.com/pulse/how-crashworthiness-engineering-saves-lives-before-airbags-xlsyf)
[3] Crash Management (https://aec.org/page/automotive-crash-management)
[4] [PDF] investigating the effects of lightweight recycled bumper and chassis ... (https://etd.lib.metu.edu.tr/upload/12620236/index.pdf)
[5] Guide for Authors (https://dergipark.org.tr/en/download/article-file/1153176)
[6] CRASH PAPER (https://www.scribd.com/document/732972844/CRASH-PAPER)
[7] Car Crash Force Interactive Calculator (https://www.firgelliauto.com/blogs/engineering-calculators/car-crash-force-calculator)
[8] Paper (JJL_OAG)_mpc-Corrected (https://strathprints.strath.ac.uk/60483/1/Ganilova_Low_PIMED_2017_Application_of_smart_honeycomb_structures_for_automotive_passive_safety.pdf)
[9] Crush characteristics of automobile structural components (https://www.govinfo.gov/content/pkg/GOVPUB-C13-b30e9dfc41591a5ac35951c76e3e761e/pdf/GOVPUB-C13-b30e9dfc41591a5ac35951c76e3e761e.pdf)
[10] Design Optimization of Crush Beams of SUV Chassis for Crashworthiness (https://www.ijsr.net/archive/v5i2/NOV161177.pdf)
[11] Crash Analysis and Size Optimization of a Vehicle's Front ... (https://dergipark.org.tr/en/download/article-file/1744326)
[12] [PDF] Structural Countermeasure Research Program - ROSA P (https://rosap.ntl.bts.gov/view/dot/41934/dot_41934_DS1.pdf)
[13] Safety standards: ANCAP vs IIHS and NHTSA (https://www.carexpert.com.au/car-news/safety-standards-ancap-vs-iihs-and-nhtsa)
[14] IOSR Journal of Mechanical and Civil Engineering (IOSR-JMCE) (http://iosrjournals.org/iosr-jmce/papers/vol17-issue5/Series-4/D1705042127%20.pdf)
[15] Vehicle crash testing - IEEE Technology Navigator (https://technav.ieee.org/topic/vehicle-crash-testing/)
