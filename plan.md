Start date: 16 Feb. 2022<br>Possible end date: somewhere in Aug. 2022

Supervisor: dr. M.G.C. Acar

Study programme: computer science / cyber security

---

Scripts from third parties are ubiquitous on modern websites. These may be included for website functionality, single sign-on, marketing, performance measurement, observing user behavior, etc. Usually such scripts have full access to the content of the webpage, including any sensitive information that the user may enter into a form. Some scripts collect this sensitive information, either intentionally (for example, for marketing), or unintentionally (because of a misconfiguration). Sometimes website owners do not even know what information is collected by third parties on their own site.

The goal of this research is to first determine to what extent sensitive information is collected from users by creating a crawler based on DuckDuckGo's [Tracker Radar Collector][tracker-radar-collector]. Ideally, there would also be time to create a tool aimed at website owners to provide insight into what information third parties on their website collect from users. An online tool that one can just enter a website URL into would be the most convenient.

[tracker-radar-collector]: https://github.com/duckduckgo/tracker-radar-collector

**Related research**
In a [2020 paper][no-boundaries], Acar et al. describe among other things how they detected collection of sensitive data displayed on webpages. In an upcoming paper, Acar et al. describe how third parties collect email addresses and sometimes accidentally even passwords of users before form submission. Oleksii et al. describe in their [2016 paper][contact-us] how they studied collection by third parties of email addresses entered into contact forms. The [2022 paper][jelly-beans] from Kats et al. shows how third parties collect search terms from internal website search functionality.

[no-boundaries]: https://doi.org/10.2478/popets-2020-0070
[contact-us]: https://doi.org/10.1515/popets-2015-0028
[jelly-beans]: https://doi.org/10.2478/popets-2022-0053

**Planning**
I will start by looking at the relevant literature on collection of sensitive information by third parties on the web.
Next, I will inspect the code of the upcoming paper by Acar et al. and a related browser add-on to get a more detailed picture of how their crawler and analysis works.

I can then build upon the ideas of these to create a crawler that can visit webpages, find forms, and simulate a user entering information. It will then capture data such as network traffic to third-party servers and log access by third-party scripts to values of input fields.
To analyze the data collected by the crawler, some more code is required. Again, I can build upon the ideas of previous related work. This analysis code will try to detect information entered by the crawler that is leaked to servers of third parties.

When this code is working, some small pilot crawls will be used to verify that the crawler and analysis code are working correctly, and to tweak some parameters.
Then, the actual large-scale crawl can be executed and its data analyzed to determine the prevalence of data leaks to third parties on popular websites.
I can then write up the results of this crawl.

If there is time, it would be very useful to also make this into a tool that can be used by website owners.
