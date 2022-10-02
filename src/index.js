process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://0c0b468004554b5387bfda0463af2579@errors.cozycloud.cc/23'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  utils,
  cozyClient
} = require('cozy-konnector-libs')
const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'didaxis'
const baseUrl = 'https://extranet.didaxis.fr/mon-espace'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  {
    log('info', 'Fetching the salary list')
    const $ = await request(`${baseUrl}/payslip.php`)

    log('info', 'Parsing salaries')
    const documents = await parseSalaries($)

    log('info', 'Saving salaries to Cozy')
    await this.saveBills(documents, fields, {
      identifiers: ['salary'],
      contentType: 'application/pdf',
      subPath: 'Salaires'
    })
  }

  {
    log('info', 'Fetching the bill list')
    const $ = await request(`${baseUrl}/bills.php`)

    log('info', 'Parsing bills')
    const documents = await parseBills($)

    log('info', 'Saving Bills to Cozy')
    await this.saveFiles(documents, fields, {
      fileIdAttributes: ['fileurl'],
      contentType: 'application/pdf',
      subPath: 'Factures'
    })
  }

  {
    log('info', 'Fetching the activity report list')
    const $ = await request(`${baseUrl}/activity_report.php`)

    log('info', 'Parsing activity reports')
    const documents = await parseActivityReports($)

    log('info', 'Saving activity reports into Cozy')
    await this.saveFiles(documents, fields, {
      fileIdAttributes: ['fileurl'],
      contentType: 'application/pdf',
      subPath: "Compte Rendu D'Activite"
    })
  }
}

// This shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return this.signin({
    url: `https://extranet.didaxis.fr/index.php`,
    formSelector: 'form',
    formData: {
      action: 'authenticate',
      login: username,
      password: password,
      submit: 'connexion'
    },
    // The validate function will check if the login request was a success. Every website has a
    // different way to respond: HTTP status code, error message in HTML ($), HTTP redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      // The login in didaxis redirect to https://extranet.didaxis.fr/mon-espace/ which return a 200
      if (statusCode === 200) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', `invalid status code: ${statusCode}`)
        return false
      }
    }
  })
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseSalaries($) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      date: {
        sel: 'td:eq(5)'
      },
      amount: {
        sel: 'td:eq(3)'
      },
      fileurl: {
        sel: 'a',
        attr: 'href',
        parse: src => `${baseUrl}/${src}`
      }
    },
    '.gradeA'
  )
    .filter(doc => doc.fileurl.includes('readfile'))
    .map(doc => {
      doc.date = parseDate(doc.date)
      doc.amount = Number(doc.amount.slice(0, -1))
      return doc
    })

  return docs.map(doc => ({
    ...doc,
    currency: 'EUR',
    filename: `salaire_${utils.formatDate(doc.date)}_${VENDOR}.pdf`,
    vendor: VENDOR,
    fileAttributes: {
      metadata: {
        contentAuthor: VENDOR,
        datetime: utils.formatDate(doc.date),
        datetimeLabel: `issueDate`,
        carbonCopy: true,
        qualification: Qualification.getByLabel('pay_sheet')
      }
    }
  }))
}

function parseBills($) {
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      dates: {
        sel: 'td:eq(4)'
      },
      fileurl: {
        sel: 'a',
        attr: 'href',
        parse: src => `${baseUrl}/${src}`
      }
    },
    '.gradeA'
  )
    .filter(doc => doc.fileurl.includes('readfile'))
    .map(doc => {
      var startDate = new Date()
      const rawStartDate = doc.dates.split(' ')[0]

      startDate.setYear(rawStartDate.split('/')[2])
      startDate.setMonth(
        Number(rawStartDate.split('/')[1]) - 1,
        rawStartDate.split('/')[0]
      ) // The months start to 0

      doc.startDate = startDate

      doc.startDate = parseDate(doc.dates.split(' ')[0])
      doc.endDate = parseDate(doc.dates.split(' ')[2])
      delete doc['dates']

      return doc
    })

  return docs.map(doc => ({
    ...doc,
    filename: `facture_${utils.formatDate(doc.startDate)}-${utils.formatDate(
      doc.endDate
    )}_${VENDOR}.pdf`,
    vendor: VENDOR
  }))
}

function parseActivityReports($) {
  const docs = scrape(
    $,
    {
      period: {
        sel: 'td:eq(2)'
      },
      fileurl: {
        sel: 'a[target=_blank]',
        attr: 'href',
        parse: src => `${baseUrl}/${src}`
      }
    },
    '.gradeA'
  ).map(doc => {
    doc.period = doc.period.replace('/', '-')
    return doc
  })
  // .filter(doc => doc.fileurl.includes('readfile'))

  return docs.map(doc => ({
    ...doc,
    filename: `cra_${doc.period}_${VENDOR}.pdf`,
    vendor: VENDOR
  }))
}

function parseDate(rawDate) {
  var date = new Date()

  date.setYear(rawDate.split('/')[2])
  date.setMonth(Number(rawDate.split('/')[1]) - 1, rawDate.split('/')[0]) // The months start to 0

  return date
}
