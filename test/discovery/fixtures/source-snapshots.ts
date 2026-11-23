/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sanitized, realistic HTML snapshots representing official government portal responses.
 * Contains no credentials or private data.
 */

// SSC (Staff Selection Commission) Snapshots
export const SSC_SNAPSHOTS = {
  normalListing: `
    <!DOCTYPE html>
    <html lang="en">
    <head><title>Staff Selection Commission - Notice Board</title></head>
    <body>
      <div class="latest-news-section">
        <table class="table table-bordered table-striped">
          <thead>
            <tr><th>Date</th><th>Title / Subject</th><th>Action</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>15/03/2026</td>
              <td>Notice of Combined Graduate Level Examination, 2026 (Advt No. HQ-CGL/2026/01)</td>
              <td><a href="https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf">Download PDF</a></td>
            </tr>
            <tr>
              <td>12/03/2026</td>
              <td>Notice of Combined Higher Secondary (10+2) Level Examination 2026 (Advt No. CHSL-2026/02)</td>
              <td><a href="https://ssc.gov.in/api/attachments/chsl-2026.pdf">Notice (PDF)</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `,

  multiPage1: `
    <html>
    <body>
      <div class="latest-news">
        <table>
          <tr>
            <td>Notice for Selection Posts Phase-XII/2026 (Advt No. Phase-XII/2026)</td>
            <td><a href="https://ssc.gov.in/files/phase-12.pdf">Notification PDF</a></td>
          </tr>
        </table>
        <div class="pagination">
          <span class="current">1</span>
          <a class="next" rel="next" href="https://ssc.gov.in/notices?page=2">Next &raquo;</a>
        </div>
      </div>
    </body>
    </html>
  `,

  multiPage2: `
    <html>
    <body>
      <div class="latest-news">
        <table>
          <tr>
            <td>Notice for Multi Tasking (Non-Technical) Staff Examination 2026 (Advt No. MTS-2026/01)</td>
            <td><a href="https://ssc.gov.in/files/mts-2026.pdf">Notification PDF</a></td>
          </tr>
        </table>
        <div class="pagination">
          <a href="https://ssc.gov.in/notices?page=1">&laquo; Prev</a>
          <span class="current">2</span>
          <span class="disabled">Next &raquo;</span>
        </div>
      </div>
    </body>
    </html>
  `,

  detailPageListing: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>Sub-Inspector in Delhi Police and Central Armed Police Forces Examination, 2026</td>
          <td><a href="https://ssc.gov.in/notice/detail/cpo-2026.html">View Details</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  detailPageContent: `
    <html>
    <head><title>CPO 2026 Details</title></head>
    <body>
      <h2>Sub-Inspector in Delhi Police and CAPFs Exam 2026 (Advt No. F.No. 3/1/2026-P&P-I)</h2>
      <div class="downloads-box">
        <a href="https://ssc.gov.in/files/cpo-2026-notification.pdf">Detailed Official Notification (PDF)</a>
        <a href="https://ssc.gov.in/files/cpo-2026-syllabus.pdf">Scheme & Detailed Syllabus (PDF)</a>
        <a href="https://ssc.gov.in/files/cpo-2026-annexures.pdf">Proforma Certificates</a>
      </div>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <table>
        <tr>
          <td>Corrigendum regarding Extension of Last Date for CGL Examination 2026 (Advt No. HQ-CGL/2026/01)</td>
          <td><a href="https://ssc.gov.in/files/corrigendum-cgl.pdf">Corrigendum Notice</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>Tender Notice for Procurement of Desktop Computers and Stationery</td>
          <td><a href="https://ssc.gov.in/tenders/tender-101.pdf">Tender Document</a></td>
        </tr>
        <tr>
          <td>Office Order regarding annual disposal of unserviceable staff vehicles and scrap</td>
          <td><a href="https://ssc.gov.in/orders/scrap-disposal.pdf">Order PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  invalidStructure: `
    <html>
    <body>
      <div class="gateway-error">502 Bad Gateway: Backend upstream server timeout</div>
    </body>
    </html>
  `,
};

// UPSC (Union Public Service Commission) Snapshots
export const UPSC_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <table class="views-table">
        <thead><tr><th>Advt No.</th><th>Recruitment Title</th><th>Document</th></tr></thead>
        <tbody>
          <tr>
            <td>Advt No. 05/2026</td>
            <td>Specialist Grade III Assistant Professor (Medical) in Ministry of Health</td>
            <td><a href="https://upsc.gov.in/sites/default/files/Advt-05-2026-Specialist.pdf">Detailed Advertisement PDF</a></td>
          </tr>
          <tr>
            <td>Advt No. 06/2026</td>
            <td>Combined Defence Services Examination (I), 2026</td>
            <td><a href="https://upsc.gov.in/sites/default/files/Advt-06-2026-CDS.pdf">Notification PDF</a></td>
          </tr>
        </tbody>
      </table>
    </body>
    </html>
  `,

  multiPage1: `
    <html>
    <body>
      <table class="views-table">
        <tr>
          <td>Advt No. 01/2026</td>
          <td>National Defence Academy and Naval Academy Examination (I), 2026</td>
          <td><a href="https://upsc.gov.in/sites/default/files/nda-1-2026.pdf">Notification</a></td>
        </tr>
      </table>
      <ul class="pager">
        <li class="pager-current">1</li>
        <li class="pager-next"><a href="https://upsc.gov.in/recruitment/advertisements?page=2">next ›</a></li>
      </ul>
    </body>
    </html>
  `,

  multiPage2: `
    <html>
    <body>
      <table class="views-table">
        <tr>
          <td>Advt No. 02/2026</td>
          <td>Central Armed Police Forces (Assistant Commandants) Examination, 2026</td>
          <td><a href="https://upsc.gov.in/sites/default/files/capf-2026.pdf">Notification</a></td>
        </tr>
      </table>
      <ul class="pager">
        <li class="pager-first"><a href="https://upsc.gov.in/recruitment/advertisements?page=1">‹ previous</a></li>
        <li class="pager-current">2</li>
      </ul>
    </body>
    </html>
  `,

  detailPageListing: `
    <html>
    <body>
      <table class="views-table">
        <tr>
          <td>Advt No. 07/2026</td>
          <td>Civil Services Examination, 2026</td>
          <td><a href="https://upsc.gov.in/examinations/civil-services-2026.html">Examination Page</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  detailPageContent: `
    <html>
    <body>
      <h1>Civil Services (Preliminary) Examination, 2026 (Advt No. 07/2026-CSP)</h1>
      <div class="exam-docs">
        <a href="https://upsc.gov.in/sites/default/files/Notification-CSP-2026.pdf">Official Recruitment Notification</a>
        <a href="https://upsc.gov.in/sites/default/files/CSE-2026-Syllabus.pdf">Detailed Syllabus</a>
        <a href="https://upsc.gov.in/sites/default/files/CSE-Instructions.pdf">How to Apply Instructions</a>
      </div>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <table class="views-table">
        <tr>
          <td>Corrigendum - Vacancy Increase for Combined Geo-Scientist Examination 2026 (Advt No. 03/2026)</td>
          <td><a href="https://upsc.gov.in/sites/default/files/Corrigendum-Geo-2026.pdf">Corrigendum Notice</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <table class="views-table">
        <tr>
          <td>Tender for Annual Maintenance Contract of Air Conditioning Units</td>
          <td><a href="https://upsc.gov.in/tenders/ac-amc.pdf">Tender Document</a></td>
        </tr>
        <tr>
          <td>Notification regarding Gazetted Holidays for the Calendar Year</td>
          <td><a href="https://upsc.gov.in/admin/holidays.pdf">Holiday List</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><div>Maintenance in progress</div></body></html>
  `,
};

// RRB (Railway Recruitment Boards) Snapshots
export const RRB_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>CEN 01/2026 (Assistant Loco Pilot - ALP)</td>
          <td>Centralized Employment Notice for recruitment of Assistant Loco Pilot</td>
          <td><a href="https://rrbapply.gov.in/docs/CEN_01_2026_ALP.pdf">Detailed Notification PDF</a></td>
        </tr>
        <tr>
          <td>CEN 02/2026 (Technician Grade I and III)</td>
          <td>Recruitment of Technicians across Railway Zones</td>
          <td><a href="https://rrbapply.gov.in/docs/CEN_02_2026_Tech.pdf">Download CEN PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  multiPage1: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>CEN 03/2026 (Non-Technical Popular Categories - NTPC)</td>
          <td><a href="https://rrbapply.gov.in/docs/CEN_03_2026_NTPC.pdf">Notification</a></td>
        </tr>
      </table>
      <div class="pagination"><a class="next" href="https://rrbapply.gov.in/notices?page=2">Next</a></div>
    </body>
    </html>
  `,

  multiPage2: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>CEN 04/2026 (Junior Engineer - JE)</td>
          <td><a href="https://rrbapply.gov.in/docs/CEN_04_2026_JE.pdf">Notification</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  regionalListing: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>CEN 01/2026 (ALP) - Regional Vacancy Breakdown for Chandigarh Zone</td>
          <td><a href="https://rrbcdg.gov.in/documents/CEN-01-2026-CDG.pdf">RRB Chandigarh ALP Notice</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>Corrigendum & Extension of Closing Date for CEN 01/2026 (ALP)</td>
          <td><a href="https://rrbapply.gov.in/docs/CEN_01_2026_Corrigendum.pdf">Corrigendum PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <table class="cen-table">
        <tr>
          <td>Quotation for Supply of Printing Paper for Computer Based Tests</td>
          <td><a href="https://rrbapply.gov.in/tenders/paper-quotation.pdf">Quotation Document</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><h1>Error 404 - File Not Found</h1></body></html>
  `,
};

// BPSC (Bihar Public Service Commission) Snapshots
export const BPSC_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>01/03/2026</td>
          <td>विज्ञापन संख्या 26/2026 - 71वीं संयुक्त प्रारंभिक प्रतियोगिता परीक्षा (71st Integrated CCE)</td>
          <td><a href="https://bpsc.bih.nic.in/Advt/Advt-26-2026-71st-CCE.pdf">Important Notice & Full Advertisement</a></td>
        </tr>
        <tr>
          <td>28/02/2026</td>
          <td>Advt. No. 27/2026 - Assistant Professor (Computer Science) in Govt. Engineering Colleges</td>
          <td><a href="https://bpsc.bih.nic.in/Advt/Advt-27-2026-AP.pdf">Notification (PDF)</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  multiPage1: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>विज्ञापन संख्या 20/2026 - Block Agriculture Officer (BAO)</td>
          <td><a href="https://bpsc.bih.nic.in/Advt/Advt-20-2026.pdf">Detailed Advertisement</a></td>
        </tr>
      </table>
      <div class="page-nav"><a href="https://bpsc.bih.nic.in/notices?page=2">Next &raquo;</a></div>
    </body>
    </html>
  `,

  multiPage2: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>विज्ञापन संख्या 21/2026 - Sub Divisional Agriculture Officer (SDAO)</td>
          <td><a href="https://bpsc.bih.nic.in/Advt/Advt-21-2026.pdf">Detailed Advertisement</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>10/03/2026</td>
          <td>शुद्धिपत्र (Corrigendum): विज्ञापन संख्या 26/2026 (71st CCE) में पदों की संख्या में संशोधन</td>
          <td><a href="https://bpsc.bih.nic.in/Advt/Corrigendum-Advt-26-2026.pdf">Corrigendum PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <table class="table">
        <tr>
          <td>निविदा सूचना (Tender Notice) - आयोग कार्यालय में जलपान गृह (Canteen) संचालन हेतु</td>
          <td><a href="https://bpsc.bih.nic.in/Tenders/Canteen-2026.pdf">Tender PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><pre>Database connection failed</pre></body></html>
  `,
};

// BSSC (Bihar Staff Selection Commission) Snapshots
export const BSSC_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <table class="notice-board">
        <tr>
          <td>विज्ञापन सं 01/2026 - 4th Graduate Level Combined Competitive Examination (4th CGL)</td>
          <td><a href="https://bssc.bihar.gov.in/advertisement/Advt-01-2026-4th-CGL.pdf">Detailed Notice</a></td>
        </tr>
        <tr>
          <td>विज्ञापन सं 02/2026 - 2nd Inter Level Combined Competitive Examination</td>
          <td><a href="https://bssc.bihar.gov.in/advertisement/Advt-02-2026-Inter.pdf">Notification PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <table class="notice-board">
        <tr>
          <td>शुद्धिपत्र: विज्ञापन संख्या 01/2026 के ऑनलाइन आवेदन की तिथि विस्तार के संबंध में</td>
          <td><a href="https://bssc.bihar.gov.in/advertisement/Corrigendum-01-2026.pdf">शुद्धिपत्र PDF</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <table class="notice-board">
        <tr>
          <td>निविदा सूचना संख्या 05/2026 - कार्यालय सुरक्षा गार्ड एजेंसी चयन हेतु</td>
          <td><a href="https://bssc.bihar.gov.in/tenders/tender-security.pdf">Tender Document</a></td>
        </tr>
      </table>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><div>Blank page</div></body></html>
  `,
};

// UPPSC (Uttar Pradesh Public Service Commission) Snapshots
export const UPPSC_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table class="table">
          <tr>
            <td>Combined State / Upper Subordinate Services (PCS) Examination-2026 (Advt No. A-1/E-1/2026)</td>
            <td><a href="https://uppsc.up.nic.in/View_Advt.aspx?ID=PCS-2026">View Advertisement</a></td>
            <td><a href="https://uppsc.up.nic.in/Advt/A-1-E-1-2026-PCS.pdf">User Instructions & Detailed Advt (PDF)</a></td>
          </tr>
          <tr>
            <td>Review Officer / Assistant Review Officer Examination 2026 (Advt No. A-2/E-1/2026)</td>
            <td><a href="https://uppsc.up.nic.in/Advt/A-2-E-1-2026-RO-ARO.pdf">Notification PDF</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  multiPage1: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>Staff Nurse Allopathic (Male/Female) Examination 2026 (Advt No. A-3/E-1/2026)</td>
            <td><a href="https://uppsc.up.nic.in/Advt/A-3-E-1-2026.pdf">Detailed Notification</a></td>
          </tr>
        </table>
        <div class="pagination"><a href="https://uppsc.up.nic.in/AllNotifications.aspx?page=2">Next &raquo;</a></div>
      </div>
    </body>
    </html>
  `,

  multiPage2: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>Assistant Prosecution Officer (APO) Examination 2026 (Advt No. A-4/E-1/2026)</td>
            <td><a href="https://uppsc.up.nic.in/Advt/A-4-E-1-2026.pdf">Detailed Notification</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>Corrigendum regarding extension of last date for PCS Exam 2026 (Advt No. A-1/E-1/2026)</td>
            <td><a href="https://uppsc.up.nic.in/Advt/Corrigendum-PCS-2026.pdf">Corrigendum Notice</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>Notice regarding e-Tender for Procurement of Examination Answer Booklets</td>
            <td><a href="https://uppsc.up.nic.in/tenders/tender-booklets.pdf">Tender Document</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><span>Session Expired</span></body></html>
  `,
};

// UPSSSC (Uttar Pradesh Subordinate Services Selection Commission) Snapshots
export const UPSSSC_SNAPSHOTS = {
  normalListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table class="table">
          <tr>
            <td>Preliminary Eligibility Test (PET) 2026 (Advt No. 01-Exam/2026)</td>
            <td><a href="https://upsssc.gov.in/Advt/01-Exam-2026-PET.pdf">Detailed Advertisement PDF</a></td>
          </tr>
          <tr>
            <td>Junior Assistant & Junior Clerk General Recruitment 2026 (Advt No. 02-Exam/2026)</td>
            <td><a href="https://upsssc.gov.in/Advt/02-Exam-2026-JA.pdf">Detailed Notification</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  corrigendumListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>संशोधित विज्ञापन: परीक्षा संख्या 01-Exam/2026 के ऑनलाइन आवेदन की अंतिम तिथि वृद्धि</td>
            <td><a href="https://upsssc.gov.in/Advt/Corrigendum-01-Exam-2026.pdf">Corrigendum PDF</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  irrelevantListing: `
    <html>
    <body>
      <div id="allnotifications">
        <table>
          <tr>
            <td>E-Tender notice for hiring of private taxi vehicles for commission members</td>
            <td><a href="https://upsssc.gov.in/tenders/taxi-hiring.pdf">Tender PDF</a></td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `,

  invalidStructure: `
    <html><body><h3>Website under reconstruction</h3></body></html>
  `,
};
