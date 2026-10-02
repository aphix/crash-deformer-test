Query (2026-10-01, `sonar`): Passenger car crash engineering, give numbers with sources: (1) In real crashes
(small overlap frontal, IIHS/NHTSA), at what crush or displacement does a front wheel / suspension separate
from the car (lower control arm, tie rod, ball joint failure loads in kN; wheel displaced rearward how many
cm before separation)? (2) Typical lower control arm ball joint and tie rod ultimate failure loads in kN.
(3) Car crusher / compactor: force needed to crush a passenger car body in tonnes, and at what point the
passenger cell / floor pan frame collapses vs the crumple zones (front rails yield force in kN, sill/rocker
axial crush force in kN). Short, numeric, cite sources.

---

- **Small-overlap front wheel separation:** a source discussing small-overlap crashes notes that wheel separation can occur in tests where the wheel is disconnected, but it does **not give a clean universal crush/displacement threshold**; it only says that in small-overlap impact the load path can shift into the front wheel, suspension, firewall, and A-pillar, and that separated wheels were observed in several production vehicles[12].
- **Front-wheel / suspension failure loads:** I did **not find a defensible source in the gathered material** giving one typical combined failure load for the lower control arm, tie rod, and ball joint in a real small-overlap crash; the closest numeric tie-rod data found were generic engineering tie-rod ultimate loads of about **560–1,326 kN** for large threaded marine tie rods, which are **not automotive parts** and should not be used for car-crash inference[8].
- **Ball joint / tie rod automotive-scale numbers:** the only automotive-relevant numeric load found in the search set was a bus tie-rod study estimating maximum force at the ball joint of **47.7 kN** by static analysis and **56 kN** by kinematic analysis[5].
- **Car crusher / compactor force:** the collected sources did **not provide a direct passenger-car crusher force in tonnes** or a clean "floor pan/frame collapses at X kN" value; one structural-crush paper did show a front-rail force of **120 kN** in a vehicle crash context, and another reported a baseline column initial peak crash load reduction measured at **10 cm deflection**, but neither is a general passenger-car crusher specification[3][15].
- **Best usable numeric takeaway from the gathered sources:** treat **~48–56 kN** as an example order of magnitude for a tie-rod ball-joint force in one vehicle design study[5], and **~120 kN** as an example front-rail force in a crash-structure paper[3].

If needed, a tighter answer can be built around a specific car model or a specific IVHS/IIHS test report, because the broad "typical" values vary a lot by vehicle mass, suspension design, and crash pulse[12].

[1] Marine Tie Rods Technical Guide | PDF (https://www.scribd.com/document/309524495/TieRodsTRG-Jan16rev)
[2] Crush characteristics of automobile structural components (https://www.govinfo.gov/content/pkg/GOVPUB-C13-b30e9dfc41591a5ac35951c76e3e761e/pdf/GOVPUB-C13-b30e9dfc41591a5ac35951c76e3e761e.pdf)
[3] http://iaeme.com/Home/journal/IJMET (https://iaeme.com/MasterAdmin/Journal_uploads/IJMET/VOLUME_9_ISSUE_9/IJMET_09_09_092.pdf)
[4] Design and Analysis of Connecting Tie Rod Assembly for ... (https://journals.indexcopernicus.com/api/file/viewByFileId/416961)
[5] [PDF] analytical design of bus passenger tie rod - IJATES (http://www.ijates.com/images/short_pdf/1470891349_1126ijates.pdf)
[6] Engineering Data (https://rodavigo.net/catalogos/DUNLOP/01%20Cabezas%20de%20r%C3%B3tula%20y%20r%C3%B3tulas/DUNLOP%2002%20Datos%20t%C3%A9cnicos.pdf)
[7] [PDF] small overlap frontal impact – experience and proposal for a future (https://www-nrd.nhtsa.dot.gov/departments/esv/24th/files/24ESV-000244.PDF)
[8] Marine Tie Rods (http://5.imimg.com/data5/WE/ME/PC/SELLER-4921507/dextra-marine-tie-rods.pdf)
[9] [PDF] Multi-body dynamic modelling and simulations for train ... (https://research-management.mq.edu.au/ws/portalfiles/portal/423265176/329033537.pdf)
[10] [PDF] Assessment of Ball Joint Behaviour under Combined Loading for ... (https://ijcrt.org/papers/IJCRT2208555.pdf)
[11] The Influence of Manufacturing Variations on a Crash ... (https://rosap.ntl.bts.gov/view/dot/9497/dot_9497_DS1.pdf)
[12] Collaborative Optimization of Vehicle Crashworthiness ... (https://pure.coventry.ac.uk/ws/files/56273959/Post_Print.pdf)
[13] IOP Conference Series: Materials (https://iopscience.iop.org/article/10.1088/1757-899X/397/1/012029/pdf)
[14] 车辆小重叠碰撞中滑移模式的研究 (https://www.qichegongcheng.com/EN/10.19562/j.chinasae.qcgc.2022.10.014)
[15] International Journal of Automotive Technology, Vol. 10, No. 4, pp. 451−457 (2009) (https://acikerisim.balikesir.edu.tr/xmlui/bitstream/handle/20.500.12462/6895/ziya-aksoy.pdf?sequence=1&isAllowed=y)
