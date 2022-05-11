Start date: 16 Feb. 2022<br>Possible end date: somewhere in Aug. 2022

Supervisor: dr. M.G.C. Acar

Study programme: computer science / cyber security

---

Scripts from third parties are ubiquitous on modern websites. These may be included for website functionality, single sign-on, marketing, performance measurement, observing user behavior, etc. Usually such scripts have full access to the content of the webpage, including any sensitive information that the user may enter into a form. Some scripts collect this sensitive information, either intentionally (for example, for marketing), or unintentionally (because of a misconfiguration). Sometimes website owners do not even know what information is collected by third parties on their own site.

The goal of this research is to determine to what extent sensitive information is collected from users by creating a crawler based on DuckDuckGo's [Tracker Radar Collector][tracker-radar-collector]. Specifically, I will be focusing on the collection of passwords by third parties. This sometimes occurs, usually because of a misconfiguration on the website. I will also make this into a tool aimed at website owners to provide insight into what information third parties on their website collect from users. An online tool that one can just enter a website URL into would be the most convenient.

[tracker-radar-collector]: https://github.com/duckduckgo/tracker-radar-collector

**Related research**
In a [2020 paper][no-boundaries], Acar et al. describe among other things how they detected collection of sensitive data displayed on webpages. In an upcoming paper, Senol et al. describe how third parties collect email addresses and sometimes accidentally even passwords of users before form submission. Oleksii et al. describe in their [2016 paper][contact-us] how they studied collection by third parties of email addresses entered into contact forms. The [2022 paper][jelly-beans] from Kats et al. shows how third parties collect search terms from internal website search functionality.

There are a number of differences between this research and the upcoming paper by Senol et al. First of all, it will focus on password leaks, not email leaks. Second, the crawler will try to actually submit the form, instead of just waiting. It should also look at elements inside Shadow DOM trees. To find the login pages from the home page, I want to use a simple machine learning method. Lastly, it should be made into a standalone tool that does not just collection but also analysis. For the mentioned paper, analysis was done using a separate script, but I may be able to use the analysis code of a related upcoming leak detection browser add-on.

[no-boundaries]: https://doi.org/10.2478/popets-2020-0070
[contact-us]: https://doi.org/10.1515/popets-2015-0028
[jelly-beans]: https://doi.org/10.2478/popets-2022-0053

**Planning**
I will start by looking at the relevant literature on collection of sensitive information by third parties on the web.
Next, I will inspect the code of the upcoming paper by Senol et al. to get a more detailed picture of how the crawler works.

I can then build upon the ideas of these to create a crawler that can visit webpages, find login forms, and simulate a user entering their username and password. It will then capture data such as network traffic to third-party servers and log access by third-party scripts to values of input fields. Most login forms will not be located on the homepage of the website, so the crawler should follow links to login pages. To detect these, I will train a simple model using machine learning.
To analyze the data collected by the crawler, I can build upon the ideas of related work. I will first look at the code of the leak detection browser add-on mentioned above and the analysis code used for the study to see how these operate. This analysis code will try to detect passwords entered by the crawler that are leaked to servers of third parties. It should be written in such a way that it can later be integrated with the crawler.

When this code is working, some small pilot crawls will be used to verify that the crawler and analysis code are working correctly, and to tweak some parameters.
Then, the actual large-scale crawl can be executed and its data analyzed to determine the prevalence of password leaks to third parties on popular websites.
I can then write up the results of this crawl.

Lastly, I will combine the crawler and analysis code into a standalone tool that can analyze a website for password leaks.
